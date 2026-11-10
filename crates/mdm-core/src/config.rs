//! <home>/config.json: the bridge port and a token for scripts (the extension
//! doesn't need it; it is recognised by its fixed ID).

use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use std::path::Path;

/// The ID that follows from the "key" in extension/manifest.json.
pub const EXTENSION_ID: &str = "jblggonfekdkfbcfpjfnemnhbofnhfki";
pub const DEFAULT_PORT: u16 = 7878;

pub struct Config {
    pub token: String,
    pub port: u16,
}

pub fn load_config(home: &Path) -> std::io::Result<Config> {
    std::fs::create_dir_all(home)?;
    let file = home.join("config.json");
    let mut saved: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    let token = match saved.get("token").and_then(Value::as_str) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => {
            let mut b = [0u8; 24];
            rand::thread_rng().fill_bytes(&mut b);
            let t = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
            if !saved.is_object() { saved = json!({}); }
            saved["token"] = Value::String(t.clone());
            std::fs::write(&file, serde_json::to_string_pretty(&saved).unwrap_or_default())?;
            t
        }
    };
    let port = saved.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0).unwrap_or(DEFAULT_PORT);
    Ok(Config { token, port })
}

/// The token alone, for the native host (never creates the file).
pub fn read_token(home: &Path) -> Option<String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(home.join("config.json")).ok()?).ok()?;
    v.get("token")?.as_str().map(String::from)
}
