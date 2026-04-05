#![cfg_attr(target_arch = "wasm32", no_std)]
#![allow(clippy::deref_addrof, dangerous_implicit_autorefs)]

pub mod amd64;
pub mod arm64;
pub mod protocol;


#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

static mut DISASSEMBLY_BUFFER: [u8; 16] = [0u8; 16];
static mut DECODED_BUFFER: [u8; 256] = [0u8; 256];

fn disassembly_input(length: u32) -> &'static [u8] {
    unsafe { &(*(&raw const DISASSEMBLY_BUFFER))[..length.min(16) as usize] }
}

#[no_mangle]
pub extern "C" fn wasm_get_disassembly_buffer() -> *mut u8 {
    (&raw mut DISASSEMBLY_BUFFER).cast()
}

#[no_mangle]
pub extern "C" fn wasm_get_decoded_buffer() -> *mut u8 {
    (&raw mut DECODED_BUFFER).cast()
}

#[no_mangle]
pub extern "C" fn wasm_decode_length(arch: u32, length: u32) -> i32 {
    let input = disassembly_input(length);
    match arch {
        0 => amd64::decode_length(input),
        1 => arm64::decode_length(input),
        _ => -1,
    }
}

#[no_mangle]
pub extern "C" fn wasm_decode_full(arch: u32, length: u32, runtime_address: u64) -> i32 {
    let input = disassembly_input(length);
    let out = unsafe { &mut (*(&raw mut DECODED_BUFFER)) };
    match arch {
        0 => amd64::decode_full(input, runtime_address, out),
        1 => arm64::decode_full(input, runtime_address, out),
        _ => -1,
    }
}
