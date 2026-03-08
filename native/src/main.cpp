#include "zydis_wasm.hpp"


extern "C" void* memset(void* s, int c, size_t n) {
  for (size_t i = 0; i < n; i++) {
    ((uint8_t*)s)[i] = c;
  }
  return s;
}

extern "C" void* memcpy(void* dest, const void* src, size_t n) {
  for (size_t i = 0; i < n; i++) {
    ((uint8_t*)dest)[i] = ((uint8_t*)src)[i];
  }
  return dest;
}

extern "C" [[clang::export_name("wasm_get_disassembled_instruction")]]
ZydisDisassembledInstruction* wasm_get_disassembled_instruction()
{
  return &disassembled_instr;
}

extern "C" [[clang::export_name("wasm_get_disassembly_buffer")]]
uint8_t* wasm_get_disassembly_buffer()
{
  return disassembly_buffer;
}

extern "C" [[clang::export_name("wasm_get_disassembled_text")]]
const char* wasm_get_disassembled_text()
{
  return disassembled_instr.text;
}

extern "C" [[clang::export_name("wasm_get_disassembled_length")]]
uint32_t wasm_get_disassembled_length()
{
  return disassembled_instr.info.length;
}

extern "C" [[clang::export_name("wasm_get_disassembled_mnemonic")]]
uint32_t wasm_get_disassembled_mnemonic()
{
  return disassembled_instr.info.mnemonic;
}

extern "C" int32_t wasm_disassemble(
  uint32_t length,
  uint64_t runtime_address
)
{
  return ZydisDisassembleIntel(
    ZYDIS_MACHINE_MODE_LONG_64,
    runtime_address,
    disassembly_buffer,
    length,
    &disassembled_instr
  );
}

extern "C" const char* wasm_mnemonic_string(uint16_t mnemonic) {
  const char* value = ZydisMnemonicGetString(static_cast<ZydisMnemonic>(mnemonic));
  return value ? value : "";
}
