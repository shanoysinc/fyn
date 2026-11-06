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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_is_stable_and_part_sensitive() {
        // Pinned values: icon cache file names depend on this never changing.
        assert_eq!(fnv1a(&[]), 0xcbf29ce484222325);
        let h = fnv1a(&[b"abc"]);
        assert_eq!(h, fnv1a(&[b"abc"]));
        // The separator means ["ab","c"] and ["a","bc"] hash differently.
        assert_ne!(fnv1a(&[b"ab", b"c"]), fnv1a(&[b"a", b"bc"]));
        assert_ne!(fnv1a(&[b"abc"]), fnv1a(&[b"abd"]));
    }

    #[test]
    fn wide_is_nul_terminated_utf16() {
        assert_eq!(wide(""), vec![0]);
        assert_eq!(wide("A"), vec![65, 0]);
        let w = wide("é😀");
        assert_eq!(w.last(), Some(&0));
        assert_eq!(String::from_utf16(&w[..w.len() - 1]).unwrap(), "é😀");
    }
}
