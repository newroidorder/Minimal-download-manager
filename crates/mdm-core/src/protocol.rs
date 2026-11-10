//! Shared by the program (bridge.rs) and the native messaging host.
//!
//! Browser <-> host: Chrome native messaging (4-byte little-endian length + JSON).
//! Host <-> program: a private named pipe, one JSON message per line, opened
//! with a two-way handshake: each side proves it knows the token in
//! <home>/config.json, a file only this Windows user can read.

use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

pub const HOST_NAME: &str = "com.minimaldm.bridge";
pub const MAX_MESSAGE: usize = 1024 * 1024; // Chrome's limit for host -> browser messages

/// Same name as the original program, so an old host still finds a new program.
pub fn pipe_path(home: &Path) -> String {
    let abs = std::path::absolute(home).unwrap_or_else(|_| home.to_path_buf());
    let hash = Sha256::digest(abs.display().to_string().to_lowercase().as_bytes());
    let hex: String = hash.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!(r"\\.\pipe\minimal-download-manager-{hex}")
}

pub fn nonce() -> String {
    let mut b = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::STANDARD.encode(b)
}

pub fn proof(token: &str, role: &str, nonce: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("hmac accepts any key");
    mac.update(format!("{role}:{nonce}").as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

pub fn verify(token: &str, role: &str, nonce: &str, value: Option<&str>) -> bool {
    let Some(got) = value.and_then(|v| base64::engine::general_purpose::STANDARD.decode(v).ok()) else { return false };
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("hmac accepts any key");
    mac.update(format!("{role}:{nonce}").as_bytes());
    mac.verify_slice(&got).is_ok() // constant-time compare
}

/// Newline-delimited JSON reader. Returns None at end of stream or on a bad
/// line (too long or not a JSON object), which must close the connection.
pub struct LineReader<R> {
    inner: BufReader<R>,
    buf: Vec<u8>,
}

impl<R: AsyncRead + Unpin> LineReader<R> {
    pub fn new(r: R) -> Self {
        LineReader { inner: BufReader::new(r), buf: Vec::new() }
    }

    pub async fn next(&mut self) -> Option<Value> {
        loop {
            self.buf.clear();
            let n = (&mut self.inner).take((MAX_MESSAGE * 2) as u64).read_until(b'\n', &mut self.buf).await.ok()?;
            if n == 0 || (self.buf.last() != Some(&b'\n') && n >= MAX_MESSAGE * 2) {
                return None;
            }
            let line = std::str::from_utf8(&self.buf).ok()?.trim();
            if line.is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(line).ok()?;
            return v.is_object().then_some(v);
        }
    }
}

use tokio::io::AsyncReadExt as _;

pub async fn write_line<W: AsyncWrite + Unpin>(w: &mut W, msg: &Value) -> std::io::Result<()> {
    let mut s = serde_json::to_vec(msg).unwrap_or_default();
    s.push(b'\n');
    w.write_all(&s).await?;
    w.flush().await
}

/// Chrome native messaging framing (blocking, for the host's stdin/stdout).
pub fn read_native(r: &mut impl Read) -> Result<Option<Value>, ()> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(_) => return Err(()),
    }
    let n = u32::from_le_bytes(len) as usize;
    if n > MAX_MESSAGE {
        return Err(());
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body).map_err(|_| ())?;
    let v: Value = serde_json::from_slice(&body).map_err(|_| ())?;
    Ok(Some(v))
}

pub fn write_native(w: &mut impl Write, msg: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(msg).unwrap_or_default();
    w.write_all(&(body.len() as u32).to_le_bytes())?;
    w.write_all(&body)?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proofs() {
        let p = proof("tok", "app", "n1");
        assert!(verify("tok", "app", "n1", Some(&p)));
        assert!(!verify("tok", "host", "n1", Some(&p)));
        assert!(!verify("other", "app", "n1", Some(&p)));
        assert!(!verify("tok", "app", "n1", None));
    }

    #[test]
    fn native_framing_roundtrip() {
        let mut buf = vec![];
        write_native(&mut buf, &serde_json::json!({ "a": 1 })).unwrap();
        let v = read_native(&mut &buf[..]).unwrap().unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!(read_native(&mut &[][..]).unwrap(), None);
    }
}
