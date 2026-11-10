//! Browser bridge: how the extension reaches the program.
//!
//! 1. Native messaging (the normal way). The browser starts the host for our
//!    extension only, and the host talks to the program over a private pipe.
//!    Both sides prove they know the token in <home>/config.json.
//! 2. HTTP on 127.0.0.1 (off by default). Requests need the extension's Origin
//!    or the bearer token, the Host header must be 127.0.0.1/localhost (no DNS
//!    rebinding), there are no CORS headers and only JSON is accepted.

use crate::http::Headers;
use crate::manager::{AddOpts, AddResult, Manager};
use crate::protocol::{nonce, proof, verify, write_line, LineReader};
use crate::rules::capture_decision;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

const FORWARDED: [&str; 4] = ["cookie", "referer", "user-agent", "accept-language"];
const KINDS: [&str; 5] = ["auto", "click", "menu", "detected", "manual"];
const MAX_BODY: usize = 64 * 1024;

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn browser_ok(b: &str) -> bool {
    (2..=12).contains(&b.len()) && b.bytes().all(|c| c.is_ascii_lowercase())
}

pub struct Hooks {
    /// A captured download was added (result.item) or is a duplicate that needs an answer.
    pub on_capture: Box<dyn Fn(AddResult, AddOpts) + Send + Sync>,
    /// A browser talked to us.
    pub on_seen: Box<dyn Fn(&str) + Send + Sync>,
    /// Browsers connected through native messaging right now, { chrome: 1, ... }.
    pub on_connections: Box<dyn Fn(HashMap<String, u32>) + Send + Sync>,
}

struct Conn {
    browser: String,
    authed: bool,
    tx: mpsc::UnboundedSender<Value>,
}

pub struct Bridge {
    manager: Manager,
    token: String,
    origins: Vec<String>,
    version: String,
    hooks: Hooks,
    conns: Mutex<HashMap<u64, Conn>>,
    next_id: AtomicU64,
    http: Mutex<Option<Arc<tiny_http::Server>>>,
}

pub struct Failure(pub u16, pub String);

impl Bridge {
    pub fn new(manager: Manager, token: String, extension_ids: &[&str], version: &str, hooks: Hooks) -> Arc<Bridge> {
        let b = Arc::new(Bridge {
            manager,
            token,
            origins: extension_ids.iter().map(|id| format!("chrome-extension://{id}")).collect(),
            version: version.to_string(),
            hooks,
            conns: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            http: Mutex::new(None),
        });
        let weak = Arc::downgrade(&b);
        b.manager.settings().on_change(move |_| {
            if let Some(b) = weak.upgrade() {
                let msg = json!({ "type": "config", "config": b.config() });
                for c in b.conns.lock().unwrap().values().filter(|c| c.authed) {
                    let _ = c.tx.send(msg.clone());
                }
            }
        });
        b
    }

    pub fn config(&self) -> Value {
        let s = self.manager.settings().get();
        json!({
            "contextMenu": s.general.context_menu,
            "bypassKey": s.general.bypass_key,
            "captureExts": s.file_types.capture,
            "browsers": s.general.browsers,
            "sendCookies": s.general.send_cookies,
        })
    }

    fn clean_headers(raw: Option<&Value>) -> Headers {
        let Some(o) = raw.and_then(Value::as_object) else { return vec![] };
        o.iter()
            .filter_map(|(k, v)| {
                let v = v.as_str()?;
                (FORWARDED.contains(&k.to_lowercase().as_str()) && v.len() < 16384 && !v.contains(['\r', '\n', '\0'])).then(|| (k.clone(), v.to_string()))
            })
            .collect()
    }

    pub fn capture(&self, b: &Value) -> Result<Value, Failure> {
        let url = b.get("url").and_then(Value::as_str).ok_or(Failure(400, "url required".into()))?;
        let kind = b.get("kind").and_then(Value::as_str).filter(|k| KINDS.contains(k)).unwrap_or("manual");
        let s = self.manager.settings().get();
        let str_of = |k: &str| b.get(k).and_then(Value::as_str);
        let d = capture_decision(&s, url, str_of("filename"), str_of("mime"), str_of("browser"), kind);
        if !d.capture {
            return Ok(json!({ "accepted": false, "reason": d.reason }));
        }
        if let Some(br) = str_of("browser").filter(|b| browser_ok(b)) {
            (self.hooks.on_seen)(br);
        }
        let mut headers = Self::clean_headers(b.get("headers"));
        if !s.general.send_cookies {
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case("cookie"));
        }
        let req = AddOpts {
            url: url.to_string(),
            filename: str_of("filename").filter(|f| !f.is_empty()).map(String::from),
            headers,
            referrer: Some(str_of("referrer").unwrap_or("").to_string()),
            kind: Some(kind.to_string()),
            interactive: true,
            ..Default::default()
        };
        let result = self.manager.add(req.clone()).map_err(|e| Failure(400, e))?;
        let id = result.item.as_ref().or(result.duplicate.as_ref()).map(|i| i.id.clone());
        (self.hooks.on_capture)(result, req);
        Ok(json!({ "accepted": true, "id": id }))
    }

    fn ping(&self, browser: Option<&str>) -> Value {
        if let Some(b) = browser.filter(|b| browser_ok(b)) {
            (self.hooks.on_seen)(b);
        }
        json!({ "app": "minimal-download-manager", "version": self.version })
    }

    pub fn live(&self) -> HashMap<String, u32> {
        let mut out = HashMap::new();
        for c in self.conns.lock().unwrap().values().filter(|c| c.authed && !c.browser.is_empty()) {
            *out.entry(c.browser.clone()).or_insert(0) += 1;
        }
        out
    }

    /// Records the browser of a connection; true if it changed.
    fn set_browser(&self, id: u64, b: Option<&str>) {
        let Some(b) = b.filter(|b| browser_ok(b)) else { return };
        {
            let mut conns = self.conns.lock().unwrap();
            let Some(c) = conns.get_mut(&id) else { return };
            if c.browser == b {
                return;
            }
            c.browser = b.to_string();
        }
        (self.hooks.on_seen)(b);
        (self.hooks.on_connections)(self.live());
    }

    /// Serves one native-host connection until it closes.
    pub async fn serve_conn<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static>(self: Arc<Self>, stream: S) {
        let (r, mut w) = tokio::io::split(stream);
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.conns.lock().unwrap().insert(id, Conn { browser: String::new(), authed: false, tx: tx.clone() });
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if write_line(&mut w, &m).await.is_err() {
                    break;
                }
            }
        });
        let my_nonce = nonce();
        let mut lines = LineReader::new(r);
        let mut challenged = false;
        let handshake = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(msg) = lines.next().await {
                let t = msg.get("type").and_then(Value::as_str);
                match (t, msg.get("nonce").and_then(Value::as_str)) {
                    (Some("hello"), Some(n)) if !challenged => {
                        challenged = true;
                        let _ = tx.send(json!({ "type": "hello", "nonce": my_nonce, "proof": proof(&self.token, "app", n) }));
                    }
                    _ if t == Some("auth") && challenged && verify(&self.token, "host", &my_nonce, msg.get("proof").and_then(Value::as_str)) => {
                        return Some(msg.get("browser").and_then(Value::as_str).map(String::from));
                    }
                    _ => return None,
                }
            }
            None
        })
        .await;
        if let Ok(Some(browser)) = handshake {
            if let Some(c) = self.conns.lock().unwrap().get_mut(&id) {
                c.authed = true;
            }
            let _ = tx.send(json!({ "type": "ready", "version": self.version, "config": self.config() }));
            self.set_browser(id, browser.as_deref());
            while let Some(msg) = lines.next().await {
                if msg.get("type").and_then(Value::as_str) == Some("browser") {
                    self.set_browser(id, msg.get("browser").and_then(Value::as_str));
                    continue;
                }
                let rid = match msg.get("id") {
                    Some(v @ (Value::Number(_) | Value::String(_))) => v.clone(),
                    _ => continue,
                };
                let browser = self.conns.lock().unwrap().get(&id).map(|c| c.browser.clone()).unwrap_or_default();
                let result = match msg.get("type").and_then(Value::as_str) {
                    Some("ping") => Ok(self.ping(Some(&browser))),
                    Some("config") => Ok(self.config()),
                    Some("capture") => {
                        let mut body = msg.get("body").cloned().unwrap_or(json!({}));
                        if !browser.is_empty() && body.is_object() {
                            body["browser"] = json!(browser);
                        }
                        self.capture(&body)
                    }
                    _ => Err(Failure(404, "unknown request".into())),
                };
                let _ = tx.send(match result {
                    Ok(r) => json!({ "id": rid, "result": r }),
                    Err(Failure(_, e)) => json!({ "id": rid, "error": e }),
                });
            }
        }
        let was = self.conns.lock().unwrap().remove(&id);
        drop(tx);
        writer.abort();
        if was.is_some_and(|c| c.authed && !c.browser.is_empty()) {
            (self.hooks.on_connections)(self.live());
        }
    }

    /// Listens on the private named pipe. Fails if another copy owns it.
    #[cfg(windows)]
    pub fn listen_pipe(self: &Arc<Self>, path: &str, rt: &tokio::runtime::Handle) -> std::io::Result<()> {
        use tokio::net::windows::named_pipe::ServerOptions;
        let _guard = rt.enter();
        let mut server = ServerOptions::new().first_pipe_instance(true).create(path)?;
        let (b, path) = (self.clone(), path.to_string());
        rt.spawn(async move {
            loop {
                if server.connect().await.is_err() {
                    continue;
                }
                let Ok(next) = ServerOptions::new().create(&path) else { return };
                let client = std::mem::replace(&mut server, next);
                tokio::spawn(b.clone().serve_conn(client));
            }
        });
        Ok(())
    }

    pub fn close(&self) {
        self.conns.lock().unwrap().clear(); // dropping senders ends the writers
        self.stop_http();
    }

    // ---------- 2. HTTP on 127.0.0.1 (opt-in) ----------

    pub fn listen_http(self: &Arc<Self>, port: u16) -> Result<u16, String> {
        let server = Arc::new(tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| e.to_string())?);
        let port = server.server_addr().to_ip().map_or(port, |a| a.port());
        *self.http.lock().unwrap() = Some(server.clone());
        let b = self.clone();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                b.handle_http(req, port);
            }
        });
        Ok(port)
    }

    pub fn stop_http(&self) {
        if let Some(s) = self.http.lock().unwrap().take() {
            s.unblock();
        }
    }

    fn handle_http(&self, mut req: tiny_http::Request, port: u16) {
        let h = |name: &'static str| req.headers().iter().find(|x| x.field.equiv(name)).map(|x| x.value.as_str().to_string());
        let (host, origin, auth, ctype) = (h("Host").unwrap_or_default(), h("Origin"), h("Authorization").unwrap_or_default(), h("Content-Type").unwrap_or_default());
        let (status, body) = (|| -> Result<Value, Failure> {
            if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
                return Err(Failure(421, "unexpected Host header".into()));
            }
            let from_ext = origin.as_ref().is_some_and(|o| self.origins.contains(o));
            if origin.is_some() && !from_ext {
                return Err(Failure(403, "origin not allowed".into()));
            }
            let token_ok = !self.token.is_empty() && auth.strip_prefix("Bearer ").is_some_and(|b| ct_eq(b.as_bytes(), self.token.as_bytes()));
            if !from_ext && !token_ok {
                return Err(Failure(401, "not allowed".into()));
            }
            let url = url::Url::parse(&format!("http://127.0.0.1{}", req.url())).map_err(|_| Failure(400, "bad request".into()))?;
            let method = req.method().as_str().to_string();
            match (method.as_str(), url.path()) {
                ("GET", "/api/ping") => {
                    let b = if from_ext { url.query_pairs().find(|(k, _)| k == "browser").map(|(_, v)| v.into_owned()) } else { None };
                    Ok(self.ping(b.as_deref()))
                }
                ("GET", "/api/config") => Ok(self.config()),
                ("POST", "/api/capture") => {
                    if !ctype.starts_with("application/json") {
                        return Err(Failure(415, "Content-Type must be application/json".into()));
                    }
                    let mut buf = Vec::new();
                    req.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut buf).map_err(|_| Failure(400, "bad body".into()))?;
                    if buf.len() > MAX_BODY {
                        return Err(Failure(413, "body too large".into()));
                    }
                    let v: Value = if buf.is_empty() { json!({}) } else { serde_json::from_slice(&buf).map_err(|_| Failure(400, "invalid JSON".into()))? };
                    self.capture(&v)
                }
                _ => Err(Failure(404, "not found".into())),
            }
        })()
        .map_or_else(|Failure(s, e)| (s, json!({ "error": e })), |v| (200, v));
        let mut res = tiny_http::Response::from_string(body.to_string()).with_status_code(status);
        for (k, v) in [("Content-Type", "application/json; charset=utf-8"), ("X-Content-Type-Options", "nosniff"), ("Cache-Control", "no-store")] {
            if let Ok(hd) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                res.add_header(hd);
            }
        }
        let _ = req.respond(res);
    }
}
