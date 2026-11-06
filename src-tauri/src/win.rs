//! Small Windows helpers shared across modules.

use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

/// Initialises COM (STA) for the current thread and uninitialises it on drop.
pub struct ComGuard {
    owns: bool,
}

impl ComGuard {
    pub fn new() -> Self {
        // S_OK / S_FALSE both mean we must balance with CoUninitialize.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        Self { owns: hr.is_ok() }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.owns {
            unsafe { CoUninitialize() };
        }
    }
}

/// Stable 64-bit FNV-1a hash (std's hasher isn't stable across releases).
pub fn fnv1a(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for part in parts {
        for b in *part {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Null-terminated UTF-16 buffer.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
