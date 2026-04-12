cmake_minimum_required(VERSION 3.21)
project(symbol_server LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

set(TRISKEL_LIB_DIR "D:/triskel/lib" CACHE PATH "Path to the native Triskel library sources")

# uSockets — C library, dependency of uWebSockets
FetchContent_Declare(
    uSockets
    GIT_REPOSITORY https://github.com/uNetworking/uSockets.git
    GIT_TAG v0.8.8
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(uSockets)

# libuv — event loop backend for uSockets
FetchContent_Declare(
    libuv
    GIT_REPOSITORY https://github.com/libuv/libuv.git
    GIT_TAG v1.49.2
    GIT_SHALLOW TRUE
)
set(LIBUV_BUILD_SHARED OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(libuv)

# Build uSockets as a static library
file(GLOB USOCKETS_SRC
    ${usockets_SOURCE_DIR}/src/*.c
    ${usockets_SOURCE_DIR}/src/eventing/*.c
    ${usockets_SOURCE_DIR}/src/crypto/*.c
)
add_library(uSockets STATIC ${USOCKETS_SRC})
target_include_directories(uSockets PUBLIC ${usockets_SOURCE_DIR}/src)
target_compile_definitions(uSockets PUBLIC LIBUS_NO_SSL LIBUS_USE_LIBUV)
target_link_libraries(uSockets PUBLIC uv_a)
if(WIN32)
    target_link_libraries(uSockets PUBLIC ws2_32)
endif()

# uWebSockets — header-only, depends on uSockets
FetchContent_Declare(
    uWebSockets
    GIT_REPOSITORY https://github.com/uNetworking/uWebSockets.git
    GIT_TAG v20.73.0
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(uWebSockets)

FetchContent_Declare(
    glaze
    GIT_REPOSITORY https://github.com/stephenberry/glaze.git
    GIT_TAG v7.3.2
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(glaze)

add_library(uWebSockets INTERFACE)
target_compile_definitions(uWebSockets INTERFACE UWS_NO_ZLIB)
target_include_directories(uWebSockets INTERFACE ${uwebsockets_SOURCE_DIR}/src)
target_link_libraries(uWebSockets INTERFACE uSockets)

if(NOT EXISTS "${TRISKEL_LIB_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "Triskel library sources were not found at ${TRISKEL_LIB_DIR}")
endif()

add_library(fmt_stub INTERFACE)
target_include_directories(fmt_stub INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/fmt_stub/include)
add_library(fmt::fmt ALIAS fmt_stub)

set(ENABLE_LLVM OFF CACHE BOOL "" FORCE)
set(ENABLE_IMGUI OFF CACHE BOOL "" FORCE)
set(ENABLE_CAIRO OFF CACHE BOOL "" FORCE)
set(ENABLE_LINTING OFF CACHE BOOL "" FORCE)

add_subdirectory(${TRISKEL_LIB_DIR} ${CMAKE_CURRENT_BINARY_DIR}/triskel)
set_target_properties(triskel PROPERTIES CXX_STANDARD 23 CXX_STANDARD_REQUIRED ON)

# Main executable
add_executable(symbol_server src/main.cpp src/native_cfg_compare.cpp)
target_include_directories(symbol_server PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(symbol_server PRIVATE uWebSockets winhttp dbghelp triskel glaze::glaze)
