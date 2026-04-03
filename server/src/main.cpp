#include <App.h>

#include <Windows.h>
#include <winhttp.h>
#include <DbgHelp.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

namespace fs = std::filesystem;

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

static std::string g_cache_dir;

static std::mutex g_inflight_mu;
static std::unordered_map<std::string, std::shared_future<std::string>> g_inflight;

// In-memory file cache: map_key -> file contents.
// Once a module is loaded, all byte-range reads are served from memory.
static std::mutex g_filecache_mu;
static std::unordered_map<std::string, std::shared_ptr<std::vector<uint8_t>>> g_filecache;

static std::mutex g_dbghelp_mu;
static std::unordered_map<std::string, DWORD64> g_loaded_pdbs;
static DWORD64 g_next_base = 0x10000000;
static HANDLE g_sym_handle = reinterpret_cast<HANDLE>(1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static std::string get_env(const char* name) {
    char* buf = nullptr;
    size_t len = 0;
    if (_dupenv_s(&buf, &len, name) == 0 && buf) {
        std::string val(buf);
        free(buf);
        return val;
    }
    return {};
}

// Parse _NT_SYMBOL_PATH of the form srv*<cache>*<server> and return the cache
// directory.  Falls back to %LOCALAPPDATA%\dbg\sym.
static std::string resolve_cache_dir() {
    auto sym_path = get_env("_NT_SYMBOL_PATH");
    if (!sym_path.empty()) {
        auto first = sym_path.find('*');
        if (first != std::string::npos) {
            auto second = sym_path.find('*', first + 1);
            auto cache = sym_path.substr(first + 1,
                second == std::string::npos ? std::string::npos : second - first - 1);
            if (!cache.empty()) return cache;
        }
    }
    auto local = get_env("LOCALAPPDATA");
    if (local.empty()) local = ".";
    return local + "\\dbg\\sym";
}

struct QueryParams {
    int64_t offset = -1;
    int64_t size = -1;
    int64_t rva = -1;
};

static QueryParams parse_query(std::string_view qs) {
    QueryParams p;
    while (!qs.empty()) {
        auto amp = qs.find('&');
        auto pair = qs.substr(0, amp);
        auto eq = pair.find('=');
        if (eq != std::string_view::npos) {
            auto key = pair.substr(0, eq);
            auto val = pair.substr(eq + 1);
            if (key == "offset") p.offset = std::stoll(std::string(val));
            else if (key == "size") p.size = std::stoll(std::string(val));
            else if (key == "rva") p.rva = std::stoll(std::string(val));
        }
        if (amp == std::string_view::npos) break;
        qs = qs.substr(amp + 1);
    }
    return p;
}

// ---------------------------------------------------------------------------
// WinHTTP download
// ---------------------------------------------------------------------------

struct WinHttpHandle {
    HINTERNET h = nullptr;
    WinHttpHandle() = default;
    explicit WinHttpHandle(HINTERNET h) : h(h) {}
    ~WinHttpHandle() { if (h) WinHttpCloseHandle(h); }
    WinHttpHandle(const WinHttpHandle&) = delete;
    WinHttpHandle& operator=(const WinHttpHandle&) = delete;
    explicit operator bool() const { return h != nullptr; }
};

// Reuse a single WinHTTP session across all requests.
static WinHttpHandle g_session;

static void init_winhttp() {
    g_session.h = WinHttpOpen(L"SymbolProxy/1.0",
                              WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                              WINHTTP_NO_PROXY_NAME,
                              WINHTTP_NO_PROXY_BYPASS, 0);
}

static std::vector<uint8_t> winhttp_get(const std::wstring& host,
                                         const std::wstring& path) {
    if (!g_session) return {};

    WinHttpHandle connect(WinHttpConnect(g_session.h, host.c_str(),
                                         INTERNET_DEFAULT_HTTPS_PORT, 0));
    if (!connect) return {};

    WinHttpHandle request(WinHttpOpenRequest(connect.h, L"GET", path.c_str(),
                                             nullptr, WINHTTP_NO_REFERER,
                                             WINHTTP_DEFAULT_ACCEPT_TYPES,
                                             WINHTTP_FLAG_SECURE));
    if (!request) return {};

    if (!WinHttpSendRequest(request.h, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request.h, nullptr)) {
        return {};
    }

    DWORD statusCode = 0;
    DWORD sz = sizeof(statusCode);
    WinHttpQueryHeaders(request.h,
                        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &sz,
                        WINHTTP_NO_HEADER_INDEX);
    if (statusCode != 200) return {};

    std::vector<uint8_t> body;
    DWORD bytesAvailable = 0;
    while (WinHttpQueryDataAvailable(request.h, &bytesAvailable) && bytesAvailable) {
        size_t prev = body.size();
        body.resize(prev + bytesAvailable);
        DWORD bytesRead = 0;
        WinHttpReadData(request.h, body.data() + prev, bytesAvailable, &bytesRead);
        body.resize(prev + bytesRead);
    }
    return body;
}

// ---------------------------------------------------------------------------
// Fetch-and-cache (runs on worker thread)
// ---------------------------------------------------------------------------

static std::string fetch_and_cache(const std::string& name,
                                    const std::string& key) {
    fs::path cache_path = fs::path(g_cache_dir) / name / key / name;

    if (fs::exists(cache_path)) return cache_path.string();

    std::wstring host = L"msdl.microsoft.com";
    std::wstring url_path = L"/download/symbols/" +
        std::wstring(name.begin(), name.end()) + L"/" +
        std::wstring(key.begin(), key.end()) + L"/" +
        std::wstring(name.begin(), name.end());

    printf("[fetch] %s/%s/%s ...\n", name.c_str(), key.c_str(), name.c_str());
    auto data = winhttp_get(host, url_path);
    if (data.empty()) {
        fprintf(stderr, "[fetch] failed for %s/%s\n", name.c_str(), key.c_str());
        return {};
    }

    fs::create_directories(cache_path.parent_path());
    std::ofstream ofs(cache_path, std::ios::binary);
    if (!ofs) return {};
    ofs.write(reinterpret_cast<const char*>(data.data()),
              static_cast<std::streamsize>(data.size()));
    ofs.close();

    printf("[fetch] cached %s (%zu bytes)\n", cache_path.string().c_str(),
           data.size());
    return cache_path.string();
}

static std::shared_ptr<std::vector<uint8_t>> load_file_cached(
        const std::string& map_key, const std::string& path) {
    {
        std::lock_guard lk(g_filecache_mu);
        auto it = g_filecache.find(map_key);
        if (it != g_filecache.end()) return it->second;
    }

    std::ifstream ifs(path, std::ios::binary | std::ios::ate);
    if (!ifs) return nullptr;

    auto file_size = static_cast<size_t>(ifs.tellg());
    auto data = std::make_shared<std::vector<uint8_t>>(file_size);
    ifs.seekg(0);
    ifs.read(reinterpret_cast<char*>(data->data()),
             static_cast<std::streamsize>(file_size));

    std::lock_guard lk(g_filecache_mu);
    g_filecache[map_key] = data;
    return data;
}

static std::shared_future<std::string> deduplicated_fetch(const std::string& name,
                                                           const std::string& key) {
    std::string map_key = name + "/" + key;
    std::lock_guard lk(g_inflight_mu);
    auto it = g_inflight.find(map_key);
    if (it != g_inflight.end()) return it->second;

    auto sf = std::async(std::launch::async, [name, key, map_key]() {
        std::string result;
        try {
            result = fetch_and_cache(name, key);
        } catch (...) {}
        std::lock_guard lk2(g_inflight_mu);
        g_inflight.erase(map_key);
        return result;
    }).share();

    g_inflight[map_key] = sf;
    return sf;
}

// ---------------------------------------------------------------------------
// DbgHelp symbolication
// ---------------------------------------------------------------------------

static void init_dbghelp() {
    SymSetOptions(SYMOPT_DEFERRED_LOADS | SYMOPT_UNDNAME);
    if (!SymInitialize(g_sym_handle, nullptr, FALSE))
        fprintf(stderr, "SymInitialize failed: %lu\n", GetLastError());
}

static DWORD64 load_pdb_module(const std::string& pdb_path, const std::string& map_key) {
    auto it = g_loaded_pdbs.find(map_key);
    if (it != g_loaded_pdbs.end()) return it->second;

    DWORD64 base = g_next_base;
    g_next_base += 0x10000000;

    std::wstring wide_path(pdb_path.begin(), pdb_path.end());
    DWORD64 loaded = SymLoadModuleExW(g_sym_handle, nullptr, wide_path.c_str(),
                                       nullptr, base, 0x10000000, nullptr, 0);
    if (!loaded) {
        fprintf(stderr, "[dbghelp] SymLoadModuleExW failed for %s: %lu\n",
                pdb_path.c_str(), GetLastError());
        return 0;
    }

    g_loaded_pdbs[map_key] = base;
    printf("[dbghelp] loaded %s at base 0x%llx\n", pdb_path.c_str(), base);
    return base;
}

// ---------------------------------------------------------------------------
// CORS helper
// ---------------------------------------------------------------------------

static bool is_localhost_origin(std::string_view origin) {
    return origin.starts_with("http://localhost");
}

template <bool SSL>
static void set_cors(uWS::HttpResponse<SSL>* res, std::string_view origin) {
    if (is_localhost_origin(origin)) {
        res->writeHeader("Access-Control-Allow-Origin", origin);
    }
    res->writeHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res->writeHeader("Access-Control-Allow-Headers", "*");
}

// ---------------------------------------------------------------------------
// PE header parsing
// ---------------------------------------------------------------------------

static int64_t pe_size_of_headers(const uint8_t* data, size_t len) {
    if (len < 0x40) return -1;
    if (data[0] != 'M' || data[1] != 'Z') return -1;

    uint64_t eLfanew = *reinterpret_cast<const uint32_t*>(data + 0x3c);
    if (eLfanew + 0x18 + 0x3c + 4 > len) return -1;
    if (*reinterpret_cast<const uint32_t*>(data + eLfanew) != 0x00004550) return -1;

    // SizeOfHeaders is at optional header offset 0x3c (PE32+)
    uint32_t sizeOfHeaders = *reinterpret_cast<const uint32_t*>(
        data + eLfanew + 0x18 + 0x3c);
    return static_cast<int64_t>(sizeOfHeaders);
}

static void send_error(uWS::HttpResponse<false>* res, uWS::Loop* loop,
                        const std::string& origin,
                        std::shared_ptr<std::atomic<bool>> aborted,
                        const char* status, const char* body) {
    loop->defer([res, origin, aborted, status, body]() {
        if (aborted->load()) return;
        set_cors(res, origin);
        res->writeStatus(status);
        res->end(body);
    });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

int main(int argc, char* argv[]) {
    int port = 9090;
    if (argc > 1) port = std::atoi(argv[1]);

    g_cache_dir = resolve_cache_dir();
    init_winhttp();
    init_dbghelp();
    printf("Cache directory: %s\n", g_cache_dir.c_str());
    printf("Starting symbol proxy on port %d\n", port);

    uWS::App()
        .options("/*", [](auto* res, auto* req) {
            auto origin = req->getHeader("origin");
            set_cors(res, origin);
            res->end();
        })
        .get("/health", [](auto* res, auto* req) {
            auto origin = req->getHeader("origin");
            set_cors(res, origin);
            res->end("OK");
        })
        .get("/headers/:name/:key", [](auto* res, auto* req) {
            auto origin = std::string(req->getHeader("origin"));
            auto name = std::string(req->getParameter("name"));
            auto key = std::string(req->getParameter("key"));

            auto aborted = std::make_shared<std::atomic<bool>>(false);
            res->onAborted([aborted]() { aborted->store(true); });

            auto fut = deduplicated_fetch(name, key);
            auto map_key = name + "/" + key;
            auto* loop = uWS::Loop::get();

            std::thread([res, loop, fut, origin, aborted, map_key]() {
                auto path = fut.get();
                if (path.empty()) {
                    send_error(res, loop, origin, aborted,
                               "502 Bad Gateway", "Failed to fetch symbol file");
                    return;
                }
                auto file_data = load_file_cached(map_key, path);
                if (!file_data) {
                    send_error(res, loop, origin, aborted,
                               "500 Internal Server Error", "Cannot read cached file");
                    return;
                }

                auto hdr_size = pe_size_of_headers(
                    file_data->data(), file_data->size());
                if (hdr_size <= 0 ||
                    static_cast<size_t>(hdr_size) > file_data->size()) {
                    send_error(res, loop, origin, aborted,
                               "422 Unprocessable Entity", "Invalid PE headers");
                    return;
                }

                loop->defer([res, origin, file_data, hdr_size, aborted]() {
                    if (aborted->load()) return;
                    set_cors(res, origin);
                    res->writeHeader("Content-Type", "application/octet-stream");
                    res->end(std::string_view(
                        reinterpret_cast<const char*>(file_data->data()),
                        static_cast<size_t>(hdr_size)));
                });
            }).detach();
        })
        .get("/modules/:name/:key", [](auto* res, auto* req) {
            auto origin = std::string(req->getHeader("origin"));
            auto name = std::string(req->getParameter("name"));
            auto key = std::string(req->getParameter("key"));
            auto qp = parse_query(req->getQuery());

            auto aborted = std::make_shared<std::atomic<bool>>(false);
            res->onAborted([aborted]() { aborted->store(true); });

            auto fut = deduplicated_fetch(name, key);
            auto map_key = name + "/" + key;
            auto* loop = uWS::Loop::get();

            std::thread([res, loop, fut, origin, qp, aborted, map_key]() {
                auto path = fut.get();
                if (path.empty()) {
                    send_error(res, loop, origin, aborted,
                               "502 Bad Gateway", "Failed to fetch symbol file");
                    return;
                }
                auto file_data = load_file_cached(map_key, path);
                if (!file_data) {
                    send_error(res, loop, origin, aborted,
                               "500 Internal Server Error", "Cannot read cached file");
                    return;
                }

                auto file_size = static_cast<int64_t>(file_data->size());
                int64_t read_offset = 0;
                int64_t read_size = file_size;
                if (qp.offset >= 0 && qp.size > 0) {
                    read_offset = qp.offset;
                    read_size = qp.size;
                    if (read_offset >= file_size) {
                        send_error(res, loop, origin, aborted,
                                   "416 Range Not Satisfiable", "Offset out of range");
                        return;
                    }
                    if (read_offset + read_size > file_size)
                        read_size = file_size - read_offset;
                }

                loop->defer([res, origin, file_data, read_offset, read_size, aborted]() {
                    if (aborted->load()) return;
                    set_cors(res, origin);
                    res->writeHeader("Content-Type", "application/octet-stream");
                    res->end(std::string_view(
                        reinterpret_cast<const char*>(file_data->data() + read_offset),
                        static_cast<size_t>(read_size)));
                });
            }).detach();
        })
        .get("/pdb/:name/:key/nearest", [](auto* res, auto* req) {
            auto origin = std::string(req->getHeader("origin"));
            auto name = std::string(req->getParameter("name"));
            auto key = std::string(req->getParameter("key"));
            auto qp = parse_query(req->getQuery());

            if (qp.rva < 0) {
                set_cors(res, origin);
                res->writeStatus("400 Bad Request");
                res->end("Missing rva query parameter");
                return;
            }

            auto aborted = std::make_shared<std::atomic<bool>>(false);
            res->onAborted([aborted]() { aborted->store(true); });

            auto fut = deduplicated_fetch(name, key);
            auto map_key = name + "/" + key;
            auto* loop = uWS::Loop::get();
            auto rva = static_cast<DWORD64>(qp.rva);

            std::thread([res, loop, fut, origin, aborted, map_key, rva]() {
                auto path = fut.get();
                if (path.empty()) {
                    send_error(res, loop, origin, aborted,
                               "502 Bad Gateway", "Failed to fetch PDB file");
                    return;
                }

                std::lock_guard lk(g_dbghelp_mu);
                DWORD64 base = load_pdb_module(path, map_key);
                if (!base) {
                    send_error(res, loop, origin, aborted,
                               "502 Bad Gateway", "Failed to load PDB");
                    return;
                }

                alignas(SYMBOL_INFO) char sym_buf[sizeof(SYMBOL_INFO) + MAX_SYM_NAME];
                auto* sym = reinterpret_cast<SYMBOL_INFO*>(sym_buf);
                sym->SizeOfStruct = sizeof(SYMBOL_INFO);
                sym->MaxNameLen = MAX_SYM_NAME;
                DWORD64 displacement = 0;

                if (!SymFromAddr(g_sym_handle, base + rva, &displacement, sym)) {
                    send_error(res, loop, origin, aborted,
                               "404 Not Found", "No symbol at address");
                    return;
                }

                auto sym_rva = sym->Address - base;
                std::string escaped_name;
                for (const char* p = sym->Name; *p; ++p) {
                    if (*p == '"' || *p == '\\') escaped_name += '\\';
                    escaped_name += *p;
                }
                char json[4096];
                snprintf(json, sizeof(json),
                         R"({"name":"%s","rva":%llu})",
                         escaped_name.c_str(), sym_rva);
                auto json_str = std::string(json);

                loop->defer([res, origin, aborted, json_str]() {
                    if (aborted->load()) return;
                    set_cors(res, origin);
                    res->writeHeader("Content-Type", "application/json");
                    res->end(json_str);
                });
            }).detach();
        })
        .listen(port, [port](auto* listenSocket) {
            if (listenSocket) {
                printf("Listening on port %d\n", port);
            } else {
                fprintf(stderr, "Failed to listen on port %d\n", port);
                exit(1);
            }
        })
        .run();

    return 0;
}
