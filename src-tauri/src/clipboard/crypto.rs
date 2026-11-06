//! Encryption for clipboard history, using Windows' own data protection (DPAPI).
//!
//! [`protect`] / [`unprotect`] encrypt items saved to disk. Tied to the signed-in Windows
//! user, so another account (or someone reading the drive) can't decrypt them.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
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
    protect_bytes(plain.as_bytes())
}

/// Encrypt raw bytes (an image) for storage, tied to the current Windows user.
pub fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    let input = blob(plain);
    let entropy = blob(ENTROPY);
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, PCWSTR::null(), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| format!("Couldn't encrypt clipboard item: {e}"))?;
        Ok(take(out))
    }
}

/// Decrypt text [`protect`] produced. Fails for another user's data or tampering.
pub fn unprotect(cipher: &[u8]) -> Result<Zeroizing<String>, String> {
    let bytes = unprotect_bytes(cipher)?;
    String::from_utf8(bytes.to_vec()).map(Zeroizing::new).map_err(|_| "Corrupt clipboard item".into())
}

/// Decrypt bytes [`protect_bytes`] produced.
pub fn unprotect_bytes(cipher: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    let input = blob(cipher);
    let entropy = blob(ENTROPY);
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| format!("Couldn't decrypt clipboard item: {e}"))?;
        Ok(Zeroizing::new(take(out)))
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
}
