#pragma once

#include <stddef.h>
#include <stdint.h>

#include <Zydis/Zydis.h>

inline ZydisDisassembledInstruction disassembled_instr;
inline uint8_t disassembly_buffer[16];

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
