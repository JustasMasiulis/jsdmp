#pragma once

#include <stddef.h>
#include <stdint.h>

#include <Zydis/Zydis.h>

inline ZydisDisassembledInstruction disassembled_instr;
inline uint8_t disassembly_buffer[16];

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

extern "C" [[clang::export_name("wasm_get_disassembled_instruction")]]
ZydisDisassembledInstruction* wasm_get_disassembled_instruction();

extern "C" [[clang::export_name("wasm_get_disassembly_buffer")]]
uint8_t* wasm_get_disassembly_buffer();

extern "C" [[clang::export_name("wasm_get_disassembled_text")]]
const char* wasm_get_disassembled_text();

extern "C" [[clang::export_name("wasm_get_disassembled_length")]]
uint32_t wasm_get_disassembled_length();

extern "C" [[clang::export_name("wasm_get_disassembled_mnemonic")]]
uint32_t wasm_get_disassembled_mnemonic();

extern "C" [[clang::export_name("wasm_get_disassembled_control_flow_kind")]]
uint32_t wasm_get_disassembled_control_flow_kind();

extern "C" [[clang::export_name("wasm_get_disassembled_has_fallthrough")]]
uint32_t wasm_get_disassembled_has_fallthrough();

extern "C" [[clang::export_name("wasm_get_disassembled_has_direct_target")]]
uint32_t wasm_get_disassembled_has_direct_target();

extern "C" [[clang::export_name("wasm_get_disassembled_direct_target")]]
uint64_t wasm_get_disassembled_direct_target();

extern "C" [[clang::export_name("wasm_disassemble")]]
int32_t wasm_disassemble(
  uint32_t length,
  uint64_t runtime_address
);

// Returns a pointer to a static Zydis mnemonic string.
extern "C" [[clang::export_name("wasm_mnemonic_string")]]
const char* wasm_mnemonic_string(
  uint16_t mnemonic
);