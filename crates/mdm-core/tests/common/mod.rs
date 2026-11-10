//! Local HTTP server that reproduces the server behaviours a download manager
//! has to survive: ranged and non-ranged files, dropped connections, lying
//! Accept-Ranges, errors, redirects, Content-Disposition and slow streams.

#![allow(dead_code)]

use rand::RngCore;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tiny_http::{Header, Response, Server};

pub static BODY: LazyLock<Vec<u8>> = LazyLock::new(|| {
    let mut b = vec![0u8; 20 * 1024 * 1024];
    rand::thread_rng().fill_bytes(&mut b);
    b
});

pub fn sha256(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

#[derive(Default)]
pub struct Stats {
    pub open: AtomicUsize,
    pub max_open: AtomicUsize,
    pub flaky_drops: AtomicUsize,
    pub fail_hits: AtomicUsize,
    pub range_starts: Mutex<Vec<u64>>,
    pub auth: Mutex<Vec<Option<String>>>,
}

pub struct Origin {
    pub base: String,
    pub port: u16,
    pub stats: Arc<Stats>,
}

/// Streams a slice in steps, optionally slowly, optionally dropping early.
struct Body {
    data: &'static [u8],
    off: usize,
    step: usize,
    delay: Duration,
    drop_at: Option<usize>,
    stats: Arc<Stats>,
}

impl Read for Body {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.drop_at.is_some_and(|d| self.off >= d) {
            std::thread::sleep(Duration::from_millis(20));
            return Err(std::io::Error::other("dropped"));
        }
        if self.off >= self.data.len() {
            return Ok(0);
        }
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        let mut n = self.step.min(buf.len()).min(self.data.len() - self.off);
        if let Some(d) = self.drop_at {
            n = n.min(d - self.off);
        }
        buf[..n].copy_from_slice(&self.data[self.off..self.off + n]);
        self.off += n;
        Ok(n)
    }
}

impl Drop for Body {
    fn drop(&mut self) {
        self.stats.open.fetch_sub(1, SeqCst);
    }
}

fn hdr(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn serve_range(req: tiny_http::Request, stats: &Arc<Stats>, slow: bool, flaky: bool) {
    let range = req.headers().iter().find(|h| h.field.equiv("Range")).map(|h| h.value.as_str().to_string());
    let body: &'static [u8] = &BODY;
    let parsed = range.as_deref().and_then(|r| r.strip_prefix("bytes=")).and_then(|r| {
        let (a, b) = r.split_once('-')?;
        Some((a.parse::<usize>().ok()?, b.parse::<usize>().ok()))
    });
    let Some((start, end)) = parsed else {
        let _ = req.respond(Response::from_data(body.to_vec()).with_header(hdr("ETag", "\"v1\"")).with_header(hdr("Accept-Ranges", "bytes")));
        return;
    };
    let end = end.map_or(body.len() - 1, |e| e.min(body.len() - 1));
    stats.range_starts.lock().unwrap().push(start as u64);
    let open = stats.open.fetch_add(1, SeqCst) + 1;
    stats.max_open.fetch_max(open, SeqCst);
    let drop_at = (flaky && stats.flaky_drops.fetch_add(1, SeqCst) < 3).then_some(100_000);
    if drop_at.is_none() && flaky {
        stats.flaky_drops.fetch_sub(1, SeqCst);
    }
    let reader = Body {
        data: &body[start..=end],
        off: 0,
        step: if slow { 32 * 1024 } else { 256 * 1024 },
        delay: Duration::from_millis(if slow { 10 } else { 2 }),
        drop_at,
        stats: stats.clone(),
    };
    let res = Response::new(206.into(), vec![hdr("ETag", "\"v1\""), hdr("Accept-Ranges", "bytes"), hdr("Content-Range", &format!("bytes {start}-{end}/{}", body.len()))], reader, Some(end - start + 1), None);
    let _ = req.respond(res);
}

pub fn start_origin() -> Origin {
    let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
    let port = server.server_addr().to_ip().unwrap().port();
    let stats = Arc::new(Stats::default());
    let st = stats.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let st = st.clone();
            std::thread::spawn(move || handle(req, &st, port));
        }
    });
    Origin { base: format!("http://127.0.0.1:{port}"), port, stats }
}

fn handle(req: tiny_http::Request, st: &Arc<Stats>, port: u16) {
    let url = req.url().to_string();
    let small = |req: tiny_http::Request, code: u16, body: &str, headers: Vec<Header>| {
        let mut r = Response::from_string(body).with_status_code(code);
        for h in headers {
            r.add_header(h);
        }
        let _ = req.respond(r);
    };
    match url.as_str() {
        "/ranged" => serve_range(req, st, false, false),
        "/slow" => serve_range(req, st, true, false),
        "/flaky" => serve_range(req, st, false, true),
        "/ignores-range" => {
            let _ = req.respond(Response::from_data(BODY.to_vec()).with_header(hdr("Accept-Ranges", "bytes")));
        }
        "/missing" => small(req, 404, "<h1>Not found</h1>", vec![hdr("Content-Type", "text/html")]),
        "/redirect-cross" => small(req, 302, "", vec![hdr("Location", &format!("http://localhost:{port}/echo-cookie"))]),
        "/redirect-same" => small(req, 302, "", vec![hdr("Location", "/echo-cookie")]),
        "/echo-cookie" => {
            let c = req.headers().iter().find(|h| h.field.equiv("Cookie")).map(|h| h.value.as_str().to_string()).unwrap_or("none".into());
            small(req, 200, &format!("cookie: {c}"), vec![])
        }
        "/attach?id=7" => small(req, 200, "%PDF-", vec![hdr("Content-Disposition", "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")]),
        "/small.txt" => small(req, 200, "hello", vec![]),
        "/lastmod.bin" => small(req, 200, "date", vec![hdr("Last-Modified", "Wed, 01 Jan 2020 10:00:00 GMT")]),
        "/fail-twice" => {
            if st.fail_hits.fetch_add(1, SeqCst) < 2 { small(req, 503, "busy", vec![]) } else { small(req, 200, "ok", vec![]) }
        }
        "/needs-auth" => {
            let a = req.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.as_str().to_string());
            st.auth.lock().unwrap().push(a.clone());
            if a.as_deref() == Some("Basic bWU6c2VjcmV0") { small(req, 200, "private", vec![]) } else { small(req, 401, "", vec![]) }
        }
        _ => small(req, 404, "", vec![]),
    }
}

pub fn tmp_dir() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("mdm-test-").tempdir().unwrap()
}

pub fn leftovers(dir: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".part") || n.ends_with(".part.json")).collect()
}
