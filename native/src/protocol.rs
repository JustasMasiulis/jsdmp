#[inline(always)]
pub fn write_u32(buf: &mut [u8], offset: usize, v: u32) {
    buf[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
}

#[inline(always)]
pub fn write_u64(buf: &mut [u8], offset: usize, v: u64) {
    buf[offset..offset + 8].copy_from_slice(&v.to_le_bytes());
}

pub fn is_branch(cf: u32) -> bool {
    (1..=3).contains(&cf)
}

pub struct FmtBuf<'a> {
    buf: &'a mut [u8],
    pos: usize,
}

impl<'a> FmtBuf<'a> {
    pub fn new(buf: &'a mut [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn len(&self) -> usize {
        self.pos
    }
}

impl core::fmt::Write for FmtBuf<'_> {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        let bytes = s.as_bytes();
        let end = self.pos + bytes.len();
        if end > self.buf.len() {
            return Err(core::fmt::Error);
        }
        self.buf[self.pos..end].copy_from_slice(bytes);
        self.pos = end;
        Ok(())
    }
}

fn is_hex_digit(b: u8) -> bool {
    matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F')
}

fn hex_digit_value(b: u8) -> u64 {
    match b {
        b'0'..=b'9' => (b - b'0') as u64,
        b'a'..=b'f' => (b - b'a' + 10) as u64,
        b'A'..=b'F' => (b - b'A' + 10) as u64,
        _ => 0,
    }
}

fn parse_hex(src: &[u8]) -> (u64, usize) {
    let mut start = 0;
    if src.len() >= 2 && src[0] == b'0' && (src[1] == b'x' || src[1] == b'X') {
        start = 2;
    }
    let mut val: u64 = 0;
    let mut i = start;
    while i < src.len() && is_hex_digit(src[i]) {
        val = val.wrapping_mul(16).wrapping_add(hex_digit_value(src[i]));
        i += 1;
    }
    if i == start {
        return (0, 0);
    }
    (val, i)
}

fn write_hex(dst: &mut [u8], val: u64) -> usize {
    if dst.len() < 3 {
        return 0;
    }
    dst[0] = b'0';
    dst[1] = b'x';
    if val == 0 {
        dst[2] = b'0';
        return 3;
    }
    let mut digits = 0u32;
    let mut v = val;
    while v > 0 {
        digits += 1;
        v >>= 4;
    }
    let total = 2 + digits as usize;
    if total > dst.len() {
        return 0;
    }
    let mut pos = total;
    v = val;
    while v > 0 {
        pos -= 1;
        let nibble = (v & 0xf) as u8;
        dst[pos] = if nibble < 10 {
            b'0' + nibble
        } else {
            b'a' + nibble - 10
        };
        v >>= 4;
    }
    total
}

pub fn resolve_addresses(
    src: &[u8],
    src_len: usize,
    dst: &mut [u8],
    runtime_address: u64,
    instr_length: u32,
    direct_target: Option<u64>,
) -> (usize, u8, [u64; 2]) {
    let mut si = 0;
    let mut di = 0;
    let mut rip_targets = [0u64; 2];
    let mut rip_count: u8 = 0;

    while si < src_len && di < dst.len() {
        if src[si] == b'$'
            && si + 1 < src_len
            && (src[si + 1] == b'+' || src[si + 1] == b'-')
        {
            if let Some(target) = direct_target {
                si += 2;
                let (_, consumed) = parse_hex(&src[si..src_len]);
                si += consumed;
                let written = write_hex(&mut dst[di..], target);
                di += written;
                continue;
            }
        }

        if si + 6 < src_len
            && src[si] == b'r'
            && src[si + 1] == b'i'
            && src[si + 2] == b'p'
            && src[si + 3] == b' '
        {
            let sign_pos = si + 4;
            if sign_pos + 2 <= src_len
                && (src[sign_pos] == b'+' || src[sign_pos] == b'-')
                && src[sign_pos + 1] == b' '
            {
                let is_neg = src[sign_pos] == b'-';
                let hex_start = sign_pos + 2;
                let (disp_val, hex_consumed) = parse_hex(&src[hex_start..src_len]);
                if hex_consumed > 0 {
                    let next_ip = runtime_address.wrapping_add(instr_length as u64);
                    let resolved = if is_neg {
                        next_ip.wrapping_sub(disp_val)
                    } else {
                        next_ip.wrapping_add(disp_val)
                    };
                    if (rip_count as usize) < 2 {
                        rip_targets[rip_count as usize] = resolved;
                        rip_count += 1;
                    }
                    let written = write_hex(&mut dst[di..], resolved);
                    di += written;
                    si = hex_start + hex_consumed;
                    continue;
                }
            }
        }

        dst[di] = src[si];
        di += 1;
        si += 1;
    }

    (di, rip_count, rip_targets)
}
