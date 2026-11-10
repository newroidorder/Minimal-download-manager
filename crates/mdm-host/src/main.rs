//! Native messaging host: the part of Minimal Download Manager the browser
//! starts for our extension (Chrome only starts it for the extension IDs in its
//! manifest). It relays messages between the extension (stdin/stdout) and the
//! program (private pipe), and tells the extension whether the program runs.

use mdm_core::protocol::{nonce, pipe_path, proof, read_native, verify, write_line, write_native, LineReader};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

const RETRY: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct State {
    conn: Option<mpsc::UnboundedSender<Value>>,
    connecting: bool,
    browser: String,
    last_status: Option<String>,
    pending: HashMap<String, tokio::task::AbortHandle>,
}

type Shared = Arc<Mutex<State>>;

fn to_browser(msg: &Value) {
    if write_native(&mut std::io::stdout().lock(), msg).is_err() {
        std::process::exit(0); // the browser went away
    }
}

fn status(st: &Shared, running: bool, version: Option<&str>) {
    let key = format!("{running}:{}", version.unwrap_or(""));
    let mut s = st.lock().unwrap();
    if s.last_status.as_deref() == Some(&key) {
        return;
    }
    s.last_status = Some(key);
    drop(s);
    to_browser(&json!({ "type": "status", "running": running, "version": version }));
}

fn home() -> PathBuf {
    std::env::var_os("MDM_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("Minimal Download Manager"))
}

/// Connects and authenticates; afterwards the pipe is served in the background.
async fn connect(st: &Shared) -> bool {
    {
        let mut s = st.lock().unwrap();
        if s.conn.is_some() {
            return true;
        }
        if s.connecting {
            return false;
        }
        s.connecting = true;
    }
    let ok = tokio::time::timeout(Duration::from_secs(5), handshake(st.clone())).await.unwrap_or(false);
    st.lock().unwrap().connecting = false;
    ok
}

async fn handshake(st: Shared) -> bool {
    let home = home();
    let pipe = std::env::var("MDM_PIPE").unwrap_or_else(|_| pipe_path(&home));
    let Some(secret) = mdm_core::config::read_token(&home) else { return false };
    let Ok(sock) = tokio::net::windows::named_pipe::ClientOptions::new().open(&pipe) else { return false };
    let (r, mut w) = tokio::io::split(sock);
    let mut lines = LineReader::new(r);
    let my_nonce = nonce();
    if write_line(&mut w, &json!({ "type": "hello", "nonce": my_nonce })).await.is_err() {
        return false;
    }
    // The program proves it knows the token before we send it anything else.
    let Some(hello) = lines.next().await else { return false };
    let their = hello["nonce"].as_str().unwrap_or("");
    if hello["type"] != "hello" || !verify(&secret, "app", &my_nonce, hello["proof"].as_str()) {
        return false;
    }
    let browser = st.lock().unwrap().browser.clone();
    if write_line(&mut w, &json!({ "type": "auth", "proof": proof(&secret, "host", their), "browser": browser })).await.is_err() {
        return false;
    }
    let Some(ready) = lines.next().await.filter(|m| m["type"] == "ready") else { return false };

    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    st.lock().unwrap().conn = Some(tx);
    status(&st, true, ready["version"].as_str());
    if ready.get("config").is_some() {
        to_browser(&json!({ "type": "config", "config": ready["config"] }));
    }
    tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if write_line(&mut w, &m).await.is_err() {
                break;
            }
        }
    });
    tokio::spawn(async move {
        while let Some(msg) = lines.next().await {
            if msg["type"] == "config" {
                to_browser(&json!({ "type": "config", "config": msg["config"] }));
            } else if let Some(id) = msg.get("id").filter(|i| !i.is_null()) {
                if let Some(t) = st.lock().unwrap().pending.remove(&id.to_string()) {
                    t.abort();
                    to_browser(&msg);
                }
            }
        }
        // The program quit: answer what is still waiting.
        let pending: Vec<String> = {
            let mut s = st.lock().unwrap();
            s.conn = None;
            s.pending.drain().map(|(id, t)| { t.abort(); id }).collect()
        };
        for id in pending {
            let id: Value = serde_json::from_str(&id).unwrap_or(Value::Null);
            to_browser(&json!({ "id": id, "error": "not-running" }));
        }
        status(&st, false, None);
    });
    true
}

async fn from_browser(st: Shared, msg: Value) {
    if msg["type"] == "hello" {
        if let Some(b) = msg["browser"].as_str().filter(|b| (2..=12).contains(&b.len()) && b.bytes().all(|c| c.is_ascii_lowercase())) {
            st.lock().unwrap().browser = b.to_string();
        }
        if connect(&st).await {
            let s = st.lock().unwrap();
            if let Some(c) = &s.conn {
                let _ = c.send(json!({ "type": "browser", "browser": s.browser }));
            }
        } else {
            status(&st, false, None);
        }
        return;
    }
    let Some(id) = msg.get("id").filter(|i| !i.is_null()).cloned() else { return };
    if !connect(&st).await {
        return to_browser(&json!({ "id": id, "error": "not-running" }));
    }
    let key = id.to_string();
    let st2 = st.clone();
    let (id2, key2) = (id.clone(), key.clone());
    let timer = tokio::spawn(async move {
        tokio::time::sleep(REQUEST_TIMEOUT).await;
        if st2.lock().unwrap().pending.remove(&key2).is_some() {
            to_browser(&json!({ "id": id2, "error": "timeout" }));
        }
    });
    let mut s = st.lock().unwrap();
    s.pending.insert(key, timer.abort_handle());
    if let Some(c) = &s.conn {
        let _ = c.send(msg);
    }
}

fn main() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    let st: Shared = Arc::default();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        loop {
            match read_native(&mut stdin) {
                Ok(Some(m)) if m.is_object() => { let _ = tx.send(m); }
                Ok(Some(_)) => {}
                Ok(None) => std::process::exit(0), // the browser closed the connection
                Err(()) => std::process::exit(1),
            }
        }
    });
    rt.block_on(async move {
        // Keep a connection to the program, so the extension knows at once when it starts or quits.
        let ticker = st.clone();
        tokio::spawn(async move {
            loop {
                let idle = { let s = ticker.lock().unwrap(); s.conn.is_none() && !s.connecting };
                if idle && !connect(&ticker).await {
                    status(&ticker, false, None);
                }
                tokio::time::sleep(RETRY).await;
            }
        });
        while let Some(msg) = rx.recv().await {
            tokio::spawn(from_browser(st.clone(), msg));
        }
    });
}
