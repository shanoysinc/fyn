//! Encryption for clipboard history, using Windows' own data protection (DPAPI).
//!
//! * [`protect`] / [`unprotect`]: for items saved to disk. Tied to the signed-in Windows
//!   user, so another account (or someone reading the drive) can't decrypt them.
//! * [`SecretText`]: for password-like items kept in memory. Encrypted with
//!   CryptProtectMemory (readable only inside this process), and wiped when dropped.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptProtectMemory, CryptUnprotectData, CryptUnprotectMemory,
    CRYPTPROTECTMEMORY_BLOCK_SIZE, CRYPTPROTECTMEMORY_SAME_PROCESS, CRYPTPROTECT_UI_FORBIDDEN,
    CRYPT_INTEGER_BLOB,
};
use zeroize::{Zeroize, Zeroizing};

/// Extra input to DPAPI so only Fyn's clipboard history can decrypt these blobs.
const ENTROPY: &[u8] = b"fyn.clipboard-history.v1";

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
}

/// Copy DPAPI's output and free (and wipe) its buffer.
unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let slice = std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize);
    let data = slice.to_vec();
    slice.zeroize();
    let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
    data
}

/// Encrypt for storage, tied to the current Windows user.
pub fn protect(plain: &str) -> Result<Vec<u8>, String> {
    let input = blob(plain.as_bytes());
    let entropy = blob(ENTROPY);
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, PCWSTR::null(), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| format!("Couldn't encrypt clipboard item: {e}"))?;
        Ok(take(out))
    }
}

/// Decrypt something [`protect`] produced. Fails for another user's data or tampering.
pub fn unprotect(cipher: &[u8]) -> Result<Zeroizing<String>, String> {
    let input = blob(cipher);
    let entropy = blob(ENTROPY);
    let mut out = CRYPT_INTEGER_BLOB::default();
    let bytes = unsafe {
        CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| format!("Couldn't decrypt clipboard item: {e}"))?;
        Zeroizing::new(take(out))
    };
    String::from_utf8(bytes.to_vec()).map(Zeroizing::new).map_err(|_| "Corrupt clipboard item".into())
}

/// Text held encrypted in memory; plain only briefly inside [`SecretText::reveal`].
pub struct SecretText {
    /// Ciphertext, padded to CryptProtectMemory's block size.
    buf: Vec<u8>,
    len: usize,
}

impl SecretText {
    pub fn new(plain: &str) -> Result<Self, String> {
        let block = CRYPTPROTECTMEMORY_BLOCK_SIZE as usize;
        let len = plain.len();
        let mut buf = vec![0u8; len.div_ceil(block).max(1) * block];
        buf[..len].copy_from_slice(plain.as_bytes());
        unsafe {
            CryptProtectMemory(buf.as_mut_ptr() as *mut _, buf.len() as u32, CRYPTPROTECTMEMORY_SAME_PROCESS)
        }
        .map_err(|e| {
            buf.zeroize();
            format!("Couldn't protect clipboard item: {e}")
        })?;
        Ok(Self { buf, len })
    }

    /// Decrypt into a buffer that's wiped when it's dropped.
    pub fn reveal(&self) -> Result<Zeroizing<String>, String> {
        let mut copy = Zeroizing::new(self.buf.clone());
        unsafe {
            CryptUnprotectMemory(copy.as_mut_ptr() as *mut _, copy.len() as u32, CRYPTPROTECTMEMORY_SAME_PROCESS)
        }
        .map_err(|e| format!("Couldn't read clipboard item: {e}"))?;
        let text = std::str::from_utf8(&copy[..self.len]).map_err(|_| "Corrupt clipboard item".to_string())?;
        Ok(Zeroizing::new(text.to_owned()))
    }

    pub fn char_count(&self) -> Result<usize, String> {
        Ok(self.reveal()?.chars().count())
    }
}

impl Drop for SecretText {
    fn drop(&mut self) {
        self.buf.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protect_round_trip() {
        let cipher = protect("hello clipboard ✓").unwrap();
        assert!(!cipher.windows(5).any(|w| w == b"hello"), "ciphertext must not contain the text");
        assert_eq!(&*unprotect(&cipher).unwrap(), "hello clipboard ✓");
    }

    #[test]
    fn tampered_data_is_rejected() {
        let mut cipher = protect("hello").unwrap();
        let last = cipher.len() - 1;
        cipher[last] ^= 0xFF;
        assert!(unprotect(&cipher).is_err());
    }

    #[test]
    fn secret_text_is_encrypted_in_memory() {
        for plain in ["kX9#mP2$vL7q", "", "a", "exactly16bytes!!", "seventeen bytes!!"] {
            let secret = SecretText::new(plain).unwrap();
            if plain.len() >= 4 {
                assert!(!secret.buf.windows(4).any(|w| w == &plain.as_bytes()[..4]), "{plain} visible in memory");
            }
            assert_eq!(&*secret.reveal().unwrap(), plain);
            assert_eq!(secret.char_count().unwrap(), plain.chars().count());
        }
    }
}
