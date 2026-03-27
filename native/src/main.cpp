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

static WasmControlFlowKind get_control_flow_kind()
{
  switch (disassembled_instr.info.meta.category) {
    case ZYDIS_CATEGORY_CALL:
      return WASM_CONTROL_FLOW_CALL;
    case ZYDIS_CATEGORY_COND_BR:
      return WASM_CONTROL_FLOW_CONDITIONAL_BRANCH;
    case ZYDIS_CATEGORY_UNCOND_BR:
      return WASM_CONTROL_FLOW_UNCONDITIONAL_BRANCH;
    case ZYDIS_CATEGORY_RET:
      return WASM_CONTROL_FLOW_RETURN;
    case ZYDIS_CATEGORY_INTERRUPT:
      return WASM_CONTROL_FLOW_INTERRUPT;
    case ZYDIS_CATEGORY_SYSCALL:
      return WASM_CONTROL_FLOW_SYSCALL;
    case ZYDIS_CATEGORY_SYSRET:
      return WASM_CONTROL_FLOW_RETURN;
    case ZYDIS_CATEGORY_SYSTEM:
      return WASM_CONTROL_FLOW_SYSTEM;
    default:
      return WASM_CONTROL_FLOW_NONE;
  }
}

static bool try_get_direct_target(uint64_t* target_address)
{
  const auto kind = get_control_flow_kind();
  if (kind != WASM_CONTROL_FLOW_CALL &&
      kind != WASM_CONTROL_FLOW_CONDITIONAL_BRANCH &&
      kind != WASM_CONTROL_FLOW_UNCONDITIONAL_BRANCH) {
    return false;
  }

  for (uint8_t index = 0; index < disassembled_instr.info.operand_count_visible; ++index) {
    const auto* operand = &disassembled_instr.operands[index];
    switch (operand->type) {
      case ZYDIS_OPERAND_TYPE_IMMEDIATE:
        if (ZYAN_SUCCESS(ZydisCalcAbsoluteAddress(
              &disassembled_instr.info,
              operand,
              disassembled_instr.runtime_address,
              target_address))) {
          return true;
        }
        if (!operand->imm.is_relative) {
          *target_address = operand->imm.value.u;
          return true;
        }
        break;
      case ZYDIS_OPERAND_TYPE_POINTER:
        *target_address = operand->ptr.offset;
        return true;
      default:
        break;
    }
  }

  return false;
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

extern "C" [[clang::export_name("wasm_get_disassembled_control_flow_kind")]]
uint32_t wasm_get_disassembled_control_flow_kind()
{
  return static_cast<uint32_t>(get_control_flow_kind());
}

extern "C" [[clang::export_name("wasm_get_disassembled_has_direct_target")]]
uint32_t wasm_get_disassembled_has_direct_target()
{
  uint64_t target = 0;
  return try_get_direct_target(&target) ? 1u : 0u;
}

extern "C" [[clang::export_name("wasm_get_disassembled_direct_target")]]
uint64_t wasm_get_disassembled_direct_target()
{
  uint64_t target = 0;
  return try_get_direct_target(&target) ? target : 0;
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