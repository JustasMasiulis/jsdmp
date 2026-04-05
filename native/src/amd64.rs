use crate::protocol::*;
use core::fmt::Write;
use yaxpeax_arch::LengthedInstruction;
use yaxpeax_x86::long_mode::{InstDecoder, Opcode, Operand};

fn decoder() -> InstDecoder {
    InstDecoder::default()
}

fn classify_control_flow(opcode: Opcode) -> u32 {
    match opcode {
        Opcode::CALL | Opcode::CALLF => 1,
        Opcode::JO
        | Opcode::JNO
        | Opcode::JB
        | Opcode::JNB
        | Opcode::JZ
        | Opcode::JNZ
        | Opcode::JA
        | Opcode::JNA
        | Opcode::JS
        | Opcode::JNS
        | Opcode::JP
        | Opcode::JNP
        | Opcode::JL
        | Opcode::JGE
        | Opcode::JG
        | Opcode::JLE
        | Opcode::JRCXZ
        | Opcode::LOOP
        | Opcode::LOOPZ
        | Opcode::LOOPNZ => 2,
        Opcode::JMP | Opcode::JMPF => 3,
        Opcode::RETURN | Opcode::RETF => 4,
        Opcode::INT | Opcode::INTO | Opcode::UD2 => 5,
        Opcode::SYSCALL | Opcode::SYSENTER => 6,
        Opcode::SYSRET | Opcode::SYSEXIT => 7,
        _ => 0,
    }
}

fn extract_direct_target(
    instr: &yaxpeax_x86::long_mode::Instruction,
    cf: u32,
    runtime_address: u64,
    length: u32,
) -> Option<u64> {
    if !is_branch(cf) {
        return None;
    }
    let next_ip = runtime_address.wrapping_add(length as u64);
    for i in 0..instr.operand_count() {
        match instr.operand(i) {
            Operand::ImmediateI8 { imm } => return Some(next_ip.wrapping_add(imm as i64 as u64)),
            Operand::ImmediateI16 { imm } => {
                return Some(next_ip.wrapping_add(imm as i64 as u64))
            }
            Operand::ImmediateI32 { imm } => {
                return Some(next_ip.wrapping_add(imm as i64 as u64))
            }
            Operand::ImmediateU8 { imm } => return Some(imm as u64),
            Operand::ImmediateU16 { imm } => return Some(imm as u64),
            Operand::ImmediateU32 { imm } => return Some(imm as u64),
            Operand::ImmediateU64 { imm } => return Some(imm),
            Operand::AbsoluteU32 { addr } => return Some(addr as u64),
            Operand::AbsoluteU64 { addr } => return Some(addr),
            _ => {}
        }
    }
    None
}

pub fn decode_length(input: &[u8]) -> i32 {
    match decoder().decode_slice(input) {
        Ok(instr) => instr.len().to_const() as i32,
        Err(_) => -1,
    }
}

pub fn decode_full(input: &[u8], runtime_address: u64, out: &mut [u8]) -> i32 {
    let instr = match decoder().decode_slice(input) {
        Ok(i) => i,
        Err(_) => return -1,
    };

    out.fill(0);

    let opcode = instr.opcode();
    let length = instr.len().to_const() as u32;
    let cf = classify_control_flow(opcode);
    let direct_target = extract_direct_target(&instr, cf, runtime_address, length);

    let word0: u32 = (((opcode as u32) & 0x3FFF) << 18)
        | ((length & 0xF) << 14)
        | ((cf & 0x7) << 8)
        | (if direct_target.is_some() { 1 } else { 0 } << 7);

    write_u32(out, 0, word0);
    write_u64(out, 16, direct_target.unwrap_or(0));

    let mut tmp = [0u8; 200];
    let mut fmt_buf = FmtBuf::new(&mut tmp);
    if write!(fmt_buf, "{}", instr).is_err() {
        return -1;
    }
    let fmt_len = fmt_buf.len();

    let (str_len, rip_count, rip_targets) =
        resolve_addresses(&tmp, fmt_len, &mut out[26..], runtime_address, length, direct_target);

    out[24] = rip_count;
    out[25] = str_len as u8;

    let targets_offset = 26 + str_len;
    for i in 0..rip_count as usize {
        write_u64(out, targets_offset + i * 8, rip_targets[i]);
    }

    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_nop() {
        assert_eq!(decode_length(&[0x90]), 1);
    }

    #[test]
    fn decode_ret() {
        let mut buf = [0u8; 256];
        assert_eq!(decode_full(&[0xC3], 0x1000, &mut buf), 0);
        let word0 = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!((word0 >> 14) & 0xF, 1);
        assert_eq!((word0 >> 8) & 0x7, 4);
    }

    #[test]
    fn decode_call_rel32() {
        let mut buf = [0u8; 256];
        assert_eq!(
            decode_full(&[0xE8, 0x10, 0x00, 0x00, 0x00], 0x1000, &mut buf),
            0
        );
        let word0 = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!((word0 >> 8) & 0x7, 1);
        assert_eq!((word0 >> 7) & 1, 1);
        let target = u64::from_le_bytes(buf[16..24].try_into().unwrap());
        assert_eq!(target, 0x1015);
    }

    #[test]
    fn formatted_string_present() {
        let mut buf = [0u8; 256];
        assert_eq!(decode_full(&[0x48, 0x89, 0xD8], 0x1000, &mut buf), 0);
        let str_len = buf[25] as usize;
        assert!(str_len > 0);
        let text = core::str::from_utf8(&buf[26..26 + str_len]).unwrap();
        assert!(text.contains("mov"));
    }

    #[test]
    fn rip_relative_resolved() {
        let mut buf = [0u8; 256];
        assert_eq!(
            decode_full(&[0x48, 0x8D, 0x05, 0x34, 0x12, 0x00, 0x00], 0x1000, &mut buf),
            0
        );
        let rip_count = buf[24];
        assert_eq!(rip_count, 1);
        let str_len = buf[25] as usize;
        let target_offset = 26 + str_len;
        let rip_target = u64::from_le_bytes(buf[target_offset..target_offset + 8].try_into().unwrap());
        assert_eq!(rip_target, 0x1000 + 7 + 0x1234);
    }

    #[test]
    fn branch_target_resolved_to_absolute() {
        let mut buf = [0u8; 256];
        assert_eq!(
            decode_full(&[0xE8, 0x10, 0x00, 0x00, 0x00], 0x1000, &mut buf),
            0
        );
        let str_len = buf[25] as usize;
        let text = core::str::from_utf8(&buf[26..26 + str_len]).unwrap();
        assert!(text.contains("0x1015"), "expected absolute address in: {}", text);
    }

    #[test]
    fn ud2_has_interrupt_cf() {
        let mut buf = [0u8; 256];
        assert_eq!(decode_full(&[0x0F, 0x0B], 0x1000, &mut buf), 0);
        let word0 = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!((word0 >> 8) & 0x7, 5);
    }
}
