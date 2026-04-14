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
pub extern "C" fn wasm_amd64_decode_length(length: u32) -> i32 {
    let input = disassembly_input(length);
    amd64::decode_length(input)
}

#[no_mangle]
pub extern "C" fn wasm_amd64_decode_full(length: u32, runtime_address: u64) -> i32 {
    let input = disassembly_input(length);
    let out = unsafe { &mut (*(&raw mut DECODED_BUFFER)) };
    amd64::decode_full(input, runtime_address, out)
}

#[no_mangle]
pub extern "C" fn wasm_arm64_decode_full(length: u32, runtime_address: u64) -> i32 {
    let input = disassembly_input(length);
    let out = unsafe { &mut (*(&raw mut DECODED_BUFFER)) };
    arm64::decode_full(input, runtime_address, out)
}
