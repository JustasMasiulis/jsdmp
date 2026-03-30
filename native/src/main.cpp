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

static WasmControlFlowKind get_control_flow_kind(const ZydisDecodedInstruction& info)
{
  switch (info.meta.category) {
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

static bool try_get_direct_target(
    WasmControlFlowKind kind,
    const ZydisDecodedInstruction& info,
    const ZydisDecodedOperand* operands,
    uint8_t operand_count_visible,
    uint64_t runtime_address,
    uint64_t* target_address)
{
  if (kind != WASM_CONTROL_FLOW_CALL &&
      kind != WASM_CONTROL_FLOW_CONDITIONAL_BRANCH &&
      kind != WASM_CONTROL_FLOW_UNCONDITIONAL_BRANCH) {
    return false;
  }

  for (uint8_t index = 0; index < operand_count_visible; ++index) {
    const auto* operand = &operands[index];
    switch (operand->type) {
      case ZYDIS_OPERAND_TYPE_IMMEDIATE:
        if (ZYAN_SUCCESS(ZydisCalcAbsoluteAddress(
              &info, operand, runtime_address, target_address))) {
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

extern "C" [[clang::export_name("wasm_get_disassembly_buffer")]]
uint8_t* wasm_get_disassembly_buffer()
{
  return disassembly_buffer;
}

extern "C" const char* wasm_mnemonic_string(uint16_t mnemonic) {
  const char* value = ZydisMnemonicGetString(static_cast<ZydisMnemonic>(mnemonic));
  return value ? value : "";
}

extern "C" int32_t wasm_decode_length(uint32_t length)
{
  ZydisDecodedInstruction instruction;
  if (!ZYAN_SUCCESS(ZydisDecoderDecodeInstruction(
        &g_decoder, nullptr, disassembly_buffer, length, &instruction))) {
    return -1;
  }
  return instruction.length;
}

static uint32_t encode_size_index(uint16_t size)
{
  switch (size) {
    case 0:    return 0;
    case 8:    return 1;
    case 16:   return 2;
    case 32:   return 3;
    case 64:   return 4;
    case 80:   return 5;
    case 128:  return 6;
    case 256:  return 7;
    case 512:  return 8;
    case 1024: return 9;
    case 2048: return 10;
    case 4096: return 11;
    default:   return 0;
  }
}

static uint32_t encode_width(uint8_t width)
{
  return width == 16 ? 0 : width == 32 ? 1 : 2;
}

static uint32_t encode_scale(uint8_t scale)
{
  return scale <= 1 ? 0 : scale == 2 ? 1 : scale == 4 ? 2 : 3;
}

static uint32_t encode_segment(ZydisRegister reg)
{
  switch (reg) {
    case ZYDIS_REGISTER_CS: return 1;
    case ZYDIS_REGISTER_SS: return 2;
    case ZYDIS_REGISTER_DS: return 3;
    case ZYDIS_REGISTER_ES: return 4;
    case ZYDIS_REGISTER_FS: return 5;
    case ZYDIS_REGISTER_GS: return 6;
    default: return 0;
  }
}

static uint32_t encode_mask_reg(ZydisRegister reg)
{
  if (reg >= ZYDIS_REGISTER_K0 && reg <= ZYDIS_REGISTER_K7) {
    return reg - ZYDIS_REGISTER_K0;
  }
  return 0;
}

static uint32_t log2_clamp(uint16_t n)
{
  if (n <= 1) return 0;
  uint32_t r = 0;
  uint16_t v = n;
  while (v > 1) { v >>= 1; r++; }
  return r > 7 ? 7 : r;
}

static uint32_t encode_mem_type(ZydisMemoryOperandType type)
{
  switch (type) {
    case ZYDIS_MEMOP_TYPE_MEM:  return 0;
    case ZYDIS_MEMOP_TYPE_AGEN: return 1;
    case ZYDIS_MEMOP_TYPE_MIB:  return 2;
    case ZYDIS_MEMOP_TYPE_VSIB: return 3;
    default: return 0;
  }
}

static void write_u16(uint8_t* buf, uint16_t v)
{
  buf[0] = (uint8_t)(v);
  buf[1] = (uint8_t)(v >> 8);
}

static void write_u32(uint8_t* buf, uint32_t v)
{
  buf[0] = (uint8_t)(v);
  buf[1] = (uint8_t)(v >> 8);
  buf[2] = (uint8_t)(v >> 16);
  buf[3] = (uint8_t)(v >> 24);
}

static void write_u64(uint8_t* buf, uint64_t v)
{
  for (int i = 0; i < 8; i++) {
    buf[i] = (uint8_t)(v >> (i * 8));
  }
}

static void pack_decoded_buffer(
    const ZydisDecodedInstruction& info,
    const ZydisDecodedOperand operands[ZYDIS_MAX_OPERAND_COUNT],
    uint64_t runtime_address)
{
  memset(decoded_buffer, 0, sizeof(decoded_buffer));

  auto cfk = get_control_flow_kind(info);
  uint64_t direct_target = 0;
  bool has_target = try_get_direct_target(
      cfk, info, operands, info.operand_count_visible, runtime_address, &direct_target);

  uint32_t avx_vl = 0;
  if (info.avx.vector_length == 128) avx_vl = 1;
  else if (info.avx.vector_length == 256) avx_vl = 2;
  else if (info.avx.vector_length == 512) avx_vl = 3;

  uint32_t visible_count = info.operand_count_visible;
  if (visible_count > 5) visible_count = 5;

  uint32_t word0 =
    ((uint32_t)(info.mnemonic & 0x7FF)           << 21) |
    ((uint32_t)(info.length & 0xF)                << 17) |
    ((uint32_t)(visible_count & 0x7)              << 14) |
    ((uint32_t)(cfk & 0x7)                        << 11) |
    ((uint32_t)(has_target ? 1 : 0)               << 10) |
    ((uint32_t)(info.encoding & 0x7)              <<  7) |
    ((uint32_t)(encode_width(info.address_width))  <<  5) |
    ((uint32_t)(encode_width(info.operand_width))  <<  3) |
    ((uint32_t)(encode_width(info.stack_width))    <<  1) |
    ((uint32_t)(info.avx.has_sae ? 1 : 0));

  write_u32(decoded_buffer + 0, word0);

  uint16_t word1 =
    ((uint16_t)(avx_vl & 0x3)                              << 14) |
    ((uint16_t)(encode_mask_reg(info.avx.mask.reg) & 0x7)  << 11) |
    ((uint16_t)(info.avx.broadcast.mode & 0xF)             <<  7) |
    ((uint16_t)(info.avx.rounding.mode & 0x3)              <<  5) |
    ((uint16_t)(info.avx.mask.mode & 0x7)                  <<  2);

  write_u16(decoded_buffer + 4, word1);
  write_u64(decoded_buffer + 8, (uint64_t)info.attributes);
  write_u64(decoded_buffer + 16, direct_target);

  for (uint32_t i = 0; i < visible_count; i++) {
    const auto& op = operands[i];
    uint8_t* slot = decoded_buffer + 24 + i * 16;

    uint32_t type_enc = 0;
    switch (op.type) {
      case ZYDIS_OPERAND_TYPE_REGISTER:  type_enc = 1; break;
      case ZYDIS_OPERAND_TYPE_MEMORY:    type_enc = 2; break;
      case ZYDIS_OPERAND_TYPE_POINTER:   type_enc = 3; break;
      case ZYDIS_OPERAND_TYPE_IMMEDIATE: type_enc = 4; break;
      default: break;
    }

    uint32_t vis_enc = 0;
    switch (op.visibility) {
      case ZYDIS_OPERAND_VISIBILITY_EXPLICIT: vis_enc = 0; break;
      case ZYDIS_OPERAND_VISIBILITY_IMPLICIT: vis_enc = 1; break;
      case ZYDIS_OPERAND_VISIBILITY_HIDDEN:   vis_enc = 2; break;
      default: break;
    }

    uint32_t op_word0 =
      ((type_enc & 0x3)                              << 30) |
      ((vis_enc & 0x3)                               << 28) |
      ((encode_size_index(op.size) & 0xF)            << 24) |
      ((uint32_t)(op.element_type & 0xF)             << 20) |
      ((uint32_t)(op.actions & 0xF)                  << 16) |
      ((log2_clamp(op.element_count) & 0x7)          << 13);

    write_u32(slot, op_word0);

    switch (op.type) {
      case ZYDIS_OPERAND_TYPE_REGISTER:
        write_u16(slot + 4, (uint16_t)op.reg.value);
        break;

      case ZYDIS_OPERAND_TYPE_MEMORY: {
        uint32_t mem_word =
          (((uint32_t)op.mem.base & 0x1FF)    << 23) |
          (((uint32_t)op.mem.index & 0x1FF)   << 14) |
          ((encode_scale(op.mem.scale) & 0x3) << 12) |
          ((op.mem.disp.has_displacement ? 1u : 0u) << 11) |
          ((encode_segment(op.mem.segment) & 0x7) << 8) |
          ((encode_mem_type(op.mem.type) & 0x3) << 6);
        write_u32(slot + 4, mem_word);
        write_u64(slot + 8, (uint64_t)op.mem.disp.value);
        break;
      }

      case ZYDIS_OPERAND_TYPE_IMMEDIATE: {
        uint8_t flags =
          ((op.imm.is_signed ? 1u : 0u) << 1) |
          ((op.imm.is_relative ? 1u : 0u));
        slot[4] = flags;
        write_u64(slot + 8, (uint64_t)op.imm.value.s);
        break;
      }

      case ZYDIS_OPERAND_TYPE_POINTER:
        write_u16(slot + 4, (uint16_t)op.ptr.segment);
        write_u32(slot + 8, op.ptr.offset);
        break;

      default:
        break;
    }
  }
}

extern "C" int32_t wasm_decode_full(uint32_t length, uint64_t runtime_address)
{
  ZydisDecodedInstruction instruction;
  ZydisDecodedOperand operands[ZYDIS_MAX_OPERAND_COUNT];

  if (!ZYAN_SUCCESS(ZydisDecoderDecodeFull(
        &g_decoder, disassembly_buffer, length, &instruction, operands))) {
    return -1;
  }

  pack_decoded_buffer(instruction, operands, runtime_address);
  return 0;
}

extern "C" uint8_t* wasm_get_decoded_buffer()
{
  return decoded_buffer;
}