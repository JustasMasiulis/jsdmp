cmake_minimum_required(VERSION 3.21)
project(web_dmp LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CMAKE_CXX_LINKER wasm-ld.exe)
set(CMAKE_C_LINKER wasm-ld.exe)

set(CMAKE_CXX_LINK_EXECUTABLE
	"wasm-ld.exe -mwasm32 --no-entry --gc-sections --lto-O3 --strip-all --compress-relocations --import-memory --shared-memory --features=bulk-memory,atomics,nontrapping-fptoint,call-indirect-overlong,mutable-globals,reference-types,multivalue,sign-ext,bulk-memory-opt --max-memory=1048576 <OBJECTS> -o <TARGET> <LINK_LIBRARIES>")

set(CMAKE_CXX_STANDARD_LIBRARIES "" CACHE INTERNAL "")
set(CMAKE_C_STANDARD_LIBRARIES "" CACHE INTERNAL "")
set(CMAKE_STANDARD_LIBRARIES "" CACHE INTERNAL "")
set(CMAKE_CXX_COMPILE_OPTIONS_MSVC_RUNTIME_LIBRARY_MultiThreaded					-Xclang -flto-visibility-public-std -D_MT)
set(CMAKE_C_COMPILE_OPTIONS_MSVC_RUNTIME_LIBRARY_MultiThreaded						-Xclang -flto-visibility-public-std -D_MT)

set(CMAKE_CXX_COMPILE_OPTIONS_MSVC_RUNTIME_LIBRARY_MultiThreadedDLL				-D_DLL -D_MT)
set(CMAKE_C_COMPILE_OPTIONS_MSVC_RUNTIME_LIBRARY_MultiThreadedDLL					-D_DLL -D_MT)

set(CMAKE_CXX_COMPILE_OPTIONS_MSVC_RUNTIME_LIBRARY_MultiThreadedDebug			-D_DEBUG -Xclang -flto-visibility-public-std -D_MT)
set(CMAKE_C_COMPILE_OPTIONS_MSVC_RUNTIME_LIBRARY_MultiThreadedDebug				-D_DEBUG -Xclang -flto-visibility-public-std -D_MT)

set(CMAKE_CXX_COMPILE_OPTIONS_MSVC_RUNTIME_LIBRARY_MultiThreadedDebugDLL	-D_DEBUG -D_DLL -D_MT)
set(CMAKE_C_COMPILE_OPTIONS_MSVC_RUNTIME_LIBRARY_MultiThreadedDebugDLL		-D_DEBUG -D_DLL -D_MT)

# add_link_options(-mwasm64 --no-entry --gc-sections --lto-O3 --strip-all --compress-relocations --import-memory --shared-memory --features=bulk-memory,atomics,memory64,nontrapping-fptoint,call-indirect-overlong,mutable-globals,reference-types,multivalue,sign-ext,bulk-memory-opt --max-memory=1048576)

add_compile_options(--target=wasm32 --no-standard-libraries -nodefaultlibs -fms-extensions -flto=full -fno-exceptions -mbulk-memory -matomics)

include(FetchContent)

# Keep Zydis lean for WASM builds.
add_compile_options(-DZYAN_NO_LIBC)

set(ZYDIS_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(ZYDIS_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(ZYDIS_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(ZYDIS_BUILD_SHARED_LIB OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
	Zydis
	GIT_REPOSITORY https://github.com/zyantific/zydis.git
	GIT_TAG v4.1.1
	GIT_SHALLOW TRUE
	SYSTEM
)
FetchContent_MakeAvailable(Zydis)

add_executable(web_dmp src/main.cpp)
target_include_directories(web_dmp PRIVATE include)
target_link_libraries(web_dmp PRIVATE Zydis)

target_compile_definitions(web_dmp PUBLIC ZYAN_NO_LIBC)

set_target_properties(
	web_dmp
    PROPERTIES
        SUFFIX ".wasm"
)

add_custom_command(TARGET web_dmp POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy $<TARGET_FILE:web_dmp> ../web/public/web_dmp.wasm
)