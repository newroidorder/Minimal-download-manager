//! Minimal Download Manager engine: settings, rules, the segmented downloader,
//! the download manager, the scheduler and the browser bridge. No UI code here.

pub mod batch;
pub mod bridge;
pub mod config;
pub mod downloader;
pub mod grabber;
pub mod http;
pub mod limiter;
pub mod manager;
pub mod protocol;
pub mod rules;
pub mod scheduler;
pub mod settings;

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Same as JavaScript's `Date.now().toString(36)`, used for generated ids.
pub fn base36_now() -> String {
    let mut n = now_ms() as u64;
    let mut out = Vec::new();
    while n > 0 {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}
