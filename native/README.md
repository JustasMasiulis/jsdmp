# Zydis WASM Interface

This folder provides a native `C` interface around Zydis that is intended to compile to WebAssembly with Emscripten.

## Build (WebAssembly)

```bash
emcmake cmake -S native -B native/build-wasm -DCMAKE_BUILD_TYPE=Release
cmake --build native/build-wasm --config Release
```

Generated artifacts (Emscripten target):

- `native/build-wasm/zydis.js`
- `native/build-wasm/zydis.wasm`

## Exported Functions

- `zydis_wasm_disassemble`
- `zydis_wasm_mnemonic_string`

See `include/zydis_wasm.hpp` for exact signatures.
