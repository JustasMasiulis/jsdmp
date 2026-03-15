# set(CMAKE_EXE_LINKER_FLAGS_INIT "-fuse-ld=wasm-ld -mwasm64 --no-entry --gc-sections --lto-O3 --strip-all --compress-relocations --import-memory --shared-memory --features=bulk-memory,atomics,memory64,nontrapping-fptoint,call-indirect-overlong,mutable-globals,reference-types,multivalue,sign-ext,bulk-memory-opt --max-memory=1048576")
# set(CMAKE_MODULE_LINKER_FLAGS_INIT "-fuse-ld=wasm-ld -mwasm64 --no-entry --gc-sections --lto-O3 --strip-all --compress-relocations --import-memory --shared-memory --features=bulk-memory,atomics,memory64,nontrapping-fptoint,call-indirect-overlong,mutable-globals,reference-types,multivalue,sign-ext,bulk-memory-opt --max-memory=1048576")
# set(CMAKE_SHARED_LINKER_FLAGS_INIT "-fuse-ld=wasm-ld -mwasm64 --no-entry --gc-sections --lto-O3 --strip-all --compress-relocations --import-memory --shared-memory --features=bulk-memory,atomics,memory64,nontrapping-fptoint,call-indirect-overlong,mutable-globals,reference-types,multivalue,sign-ext,bulk-memory-opt --max-memory=1048576")

set(compile_flags "-fuse-ld=wasm-ld -mwasm32 --no-standard-libraries -nodefaultlibs -fms-extensions -flto=full -fno-exceptions -mbulk-memory -matomics")

set(CMAKE_C_COMPILE_OPTIONS_MSVC_RUNTIME_LIBRARY_MultiThreaded "")
set(CMAKE_CXX_COMPILE_OPTIONS_MSVC_RUNTIME_LIBRARY_MultiThreaded "")

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(CMAKE_C_COMPILER_ID Clang)
set(CMAKE_C_COMPILER_FRONTEND_VARIANT GNU)

set(CMAKE_CXX_COMPILER_ID Clang)
set(CMAKE_CXX_COMPILER_FRONTEND_VARIANT GNU)

set(CMAKE_C_PLATFORM_ID "emscripten")
set(CMAKE_CXX_PLATFORM_ID "emscripten")
