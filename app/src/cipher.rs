//! Saved passwords are encrypted with Windows DPAPI: only this Windows user on
//! this PC can read them. Passwords saved by the Electron version (safeStorage:
//! "v10" + AES-256-GCM with a DPAPI-protected key in "Local State") are still
//! read, and written back as plain DPAPI on the next save.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use mdm_core::settings::Cipher;
use std::path::Path;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if protect {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out)
        } else {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out)
        }
    };
    if ok == 0 {
        return Err("DPAPI failed".into());
    }
    let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe { LocalFree(out.pbData as _) };
    Ok(v)
}

pub struct Dpapi {
    legacy_key: Option<Vec<u8>>,
}

impl Dpapi {
    pub fn new(home: &Path) -> Self {
        // Electron's key: os_crypt.encrypted_key = base64("DPAPI" + DPAPI blob)
        let legacy_key = std::fs::read_to_string(home.join("Local State"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.pointer("/os_crypt/encrypted_key").and_then(|k| k.as_str()).map(String::from))
            .and_then(|k| B64.decode(k).ok())
            .and_then(|k| k.strip_prefix(b"DPAPI").map(<[u8]>::to_vec))
            .and_then(|blob| dpapi(&blob, false).ok());
        Dpapi { legacy_key }
    }
}

impl Cipher for Dpapi {
    fn encrypt(&self, text: &str) -> Result<String, String> {
        dpapi(text.as_bytes(), true).map(|b| B64.encode(b))
    }

    fn decrypt(&self, b64: &str) -> Result<String, String> {
        let raw = B64.decode(b64).map_err(|e| e.to_string())?;
        let plain = match raw.strip_prefix(b"v10") {
            Some(rest) if rest.len() > 12 => {
                let key = self.legacy_key.as_ref().ok_or("no key from the old version")?;
                let gcm = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
                gcm.decrypt(Nonce::from_slice(&rest[..12]), &rest[12..]).map_err(|_| "cannot decrypt".to_string())?
            }
            _ => dpapi(&raw, false)?,
        };
        String::from_utf8(plain).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let c = Dpapi { legacy_key: None };
        let e = c.encrypt("secret ção").unwrap();
        assert_eq!(c.decrypt(&e).unwrap(), "secret ção");
    }

    #[test]
    fn legacy_electron_value() {
        let key = [7u8; 32];
        let gcm = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce = [1u8; 12];
        let mut blob = b"v10".to_vec();
        blob.extend_from_slice(&nonce);
        blob.extend(gcm.encrypt(Nonce::from_slice(&nonce), b"old pass".as_ref()).unwrap());
        let c = Dpapi { legacy_key: Some(key.to_vec()) };
        assert_eq!(c.decrypt(&B64.encode(blob)).unwrap(), "old pass");
    }
}
