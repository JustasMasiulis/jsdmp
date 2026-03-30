#pragma once

#include <stddef.h>
#include <stdint.h>

#include <Zydis/Zydis.h>

inline uint8_t disassembly_buffer[16];
inline uint8_t decoded_buffer[104];

enum WasmControlFlowKind : uint32_t {
  WASM_CONTROL_FLOW_NONE = 0,
  WASM_CONTROL_FLOW_CALL = 1,
  WASM_CONTROL_FLOW_CONDITIONAL_BRANCH = 2,
  WASM_CONTROL_FLOW_UNCONDITIONAL_BRANCH = 3,
  WASM_CONTROL_FLOW_RETURN = 4,
  WASM_CONTROL_FLOW_INTERRUPT = 5,
  WASM_CONTROL_FLOW_SYSCALL = 6,
  WASM_CONTROL_FLOW_SYSTEM = 7,
};

constinit inline ZydisDecoder g_decoder =  []() constexpr {
  ZydisDecoder d;
  constexpr ZyanU32 decoder_modes =
    (1 << ZYDIS_DECODER_MODE_MPX) |
    (1 << ZYDIS_DECODER_MODE_CET) |
    (1 << ZYDIS_DECODER_MODE_LZCNT) |
    (1 << ZYDIS_DECODER_MODE_TZCNT) |
    (1 << ZYDIS_DECODER_MODE_CLDEMOTE) |
    (1 << ZYDIS_DECODER_MODE_IPREFETCH);
  d.decoder_mode = decoder_modes;
  d.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
  d.stack_width = ZYDIS_STACK_WIDTH_64;
  return d;
}();

extern "C" [[clang::export_name("wasm_get_disassembly_buffer")]]
uint8_t* wasm_get_disassembly_buffer();

extern "C" [[clang::export_name("wasm_mnemonic_string")]]
const char* wasm_mnemonic_string(uint16_t mnemonic);

extern "C" [[clang::export_name("wasm_decode_length")]]
int32_t wasm_decode_length(uint32_t length);

extern "C" [[clang::export_name("wasm_decode_full")]]
int32_t wasm_decode_full(uint32_t length, uint64_t runtime_address);

extern "C" [[clang::export_name("wasm_get_decoded_buffer")]]
uint8_t* wasm_get_decoded_buffer();
