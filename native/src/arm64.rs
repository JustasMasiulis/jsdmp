use crate::protocol::*;
use core::fmt::Write;
use yaxpeax_arch::{Decoder, U8Reader};
use yaxpeax_arm::armv8::a64::{InstDecoder, Instruction, Opcode, Operand};

fn decoder() -> InstDecoder {
    InstDecoder::default()
}

fn classify_control_flow(opcode: Opcode) -> u32 {
    match opcode {
        Opcode::BL | Opcode::BLR => 1,
        Opcode::Bcc(_) | Opcode::CBZ | Opcode::CBNZ | Opcode::TBZ | Opcode::TBNZ => 2,
        Opcode::B | Opcode::BR => 3,
        Opcode::RET => 4,
        Opcode::BRK | Opcode::HLT => 5,
        Opcode::SVC | Opcode::HVC | Opcode::SMC => 6,
        Opcode::MSR | Opcode::MRS => 7,
        _ => 0,
    }
}

fn extract_direct_target(instr: &Instruction, cf: u32, runtime_address: u64) -> Option<u64> {
    if !is_branch(cf) {
        return None;
    }
    for op in &instr.operands {
        match *op {
            Operand::PCOffset(off) => return Some(runtime_address.wrapping_add(off as u64)),
            Operand::Immediate(v) => return Some(v as u64),
            Operand::Imm64(v) => return Some(v),
            Operand::Nothing => break,
            _ => {}
        }
    }
    None
}

pub fn opcode_discriminant(opcode: Opcode) -> u16 {
    unsafe { *(&opcode as *const Opcode as *const u16) }
}

pub fn decode_length(input: &[u8]) -> i32 {
    if input.len() < 4 {
        return -1;
    }
    let mut reader = U8Reader::new(input);
    match decoder().decode(&mut reader) {
        Ok(_) => 4,
        Err(_) => -1,
    }
}

pub fn decode_full(input: &[u8], runtime_address: u64, out: &mut [u8]) -> i32 {
    if input.len() < 4 {
        return -1;
    }
    let mut reader = U8Reader::new(input);
    let instr: Instruction = match decoder().decode(&mut reader) {
        Ok(i) => i,
        Err(_) => return -1,
    };

    let opcode = instr.opcode;
    let cf = classify_control_flow(opcode);
    let direct_target = extract_direct_target(&instr, cf, runtime_address);
    let disc = opcode_discriminant(opcode) as u32;

    let word0: u32 = ((disc & 0x3FFF) << 18)
        | ((4u32 & 0xF) << 14)
        | ((cf & 0x7) << 8)
        | (if direct_target.is_some() { 1 } else { 0 } << 7);

    out.fill(0);
    write_u32(out, 0, word0);
    write_u64(out, 16, direct_target.unwrap_or(0));

    let mut tmp = [0u8; 200];
    let mut fmt_buf = FmtBuf::new(&mut tmp);
    if write!(fmt_buf, "{}", instr).is_err() {
        return -1;
    }
    let fmt_len = fmt_buf.len();

    let (str_len, rip_count, rip_targets) =
        resolve_addresses(&tmp, fmt_len, &mut out[26..], runtime_address, 4, direct_target);

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
    fn decode_arm_nop() {
        assert_eq!(decode_length(&[0x1F, 0x20, 0x03, 0xD5]), 4);
    }

    #[test]
    fn decode_arm_ret() {
        let mut buf = [0u8; 256];
        assert_eq!(decode_full(&[0xC0, 0x03, 0x5F, 0xD6], 0x1000, &mut buf), 0);
        let word0 = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!((word0 >> 8) & 0x7, 4);
    }

    #[test]
    fn decode_arm_bl() {
        let mut buf = [0u8; 256];
        assert_eq!(decode_full(&[0x05, 0x00, 0x00, 0x94], 0x1000, &mut buf), 0);
        let word0 = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!((word0 >> 8) & 0x7, 1);
        assert_eq!((word0 >> 7) & 1, 1);
    }

    #[test]
    fn formatted_string_present() {
        let mut buf = [0u8; 256];
        assert_eq!(
            decode_full(&[0xE0, 0x03, 0x01, 0xAA], 0x1000, &mut buf),
            0
        );
        let str_len = buf[25] as usize;
        assert!(str_len > 0);
        let text = core::str::from_utf8(&buf[26..26 + str_len]).unwrap();
        assert!(!text.is_empty(), "formatted string should not be empty");
    }
}
