mod common;

use common::tmp_dir;
use mdm_core::bridge::{Bridge, Hooks};
use mdm_core::http::build_client;
use mdm_core::manager::{Manager, ManagerConfig};
use mdm_core::protocol::{nonce, proof, write_line, LineReader};
use mdm_core::settings::{defaults, SettingsStore};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const EXT: &str = "jblggonfekdkfbcfpjfnemnhbofnhfki";

fn setup(dir: &std::path::Path) -> (Arc<Bridge>, Manager, Arc<Mutex<Vec<String>>>) {
    let settings = Arc::new(SettingsStore::new(None, dir.to_path_buf(), None));
    settings.update(&json!({ "downloads": { "showFileInfo": false } })).unwrap();
    let (m, _rx) = Manager::new(ManagerConfig {
        client: build_client(&defaults(dir).proxy, None),
        settings,
        state_file: None,
        run_program: None,
        tweak: None,
        rt: tokio::runtime::Handle::current(),
    });
    let captured = Arc::new(Mutex::new(vec![]));
    let c = captured.clone();
    let hooks = Hooks {
        on_capture: Box::new(move |r, _| c.lock().unwrap().push(r.item.map(|i| i.url).unwrap_or_default())),
        on_seen: Box::new(|_| {}),
        on_connections: Box::new(|_| {}),
    };
    (Bridge::new(m.clone(), "secret-token".into(), &[EXT], "3.0.0", hooks), m, captured)
}

#[tokio::test(flavor = "multi_thread")]
async fn http_bridge_checks() {
    let dir = tmp_dir();
    let (b, _m, captured) = setup(dir.path());
    let port = b.listen_http(0).unwrap();
    let c = reqwest::Client::new();
    let base = format!("http://127.0.0.1:{port}");
    let status = |r: reqwest::Response| r.status().as_u16();

    // DNS rebinding: a foreign Host header is refused
    assert_eq!(status(c.get(format!("{base}/api/ping")).header("Host", "evil.com").send().await.unwrap()), 421);
    // a web page's Origin is refused, even with the token
    assert_eq!(status(c.get(format!("{base}/api/ping")).header("Origin", "https://evil.com").bearer_auth("secret-token").send().await.unwrap()), 403);
    // no Origin and no token
    assert_eq!(status(c.get(format!("{base}/api/ping")).send().await.unwrap()), 401);
    assert_eq!(status(c.get(format!("{base}/api/ping")).bearer_auth("wrong").send().await.unwrap()), 401);
    // the extension's Origin, or the token
    assert_eq!(status(c.get(format!("{base}/api/ping")).header("Origin", format!("chrome-extension://{EXT}")).send().await.unwrap()), 200);
    assert_eq!(status(c.get(format!("{base}/api/config")).bearer_auth("secret-token").send().await.unwrap()), 200);
    // JSON only
    let r = c.post(format!("{base}/api/capture")).bearer_auth("secret-token").header("Content-Type", "text/plain").body("{}").send().await.unwrap();
    assert_eq!(status(r), 415);
    let r = c.post(format!("{base}/api/capture")).bearer_auth("secret-token").header("Content-Type", "application/json").body(json!({ "url": "http://127.0.0.1:1/a.zip", "kind": "auto" }).to_string()).send().await.unwrap();
    let v: Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
    assert_eq!(v["accepted"], true);
    assert_eq!(captured.lock().unwrap().as_slice(), ["http://127.0.0.1:1/a.zip"]);
    b.stop_http();
}

#[tokio::test(flavor = "multi_thread")]
async fn pipe_handshake() {
    let dir = tmp_dir();
    let (b, m, _) = setup(dir.path());

    // a host that knows the token gets in and can capture
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    tokio::spawn(b.clone().serve_conn(theirs));
    let (r, mut w) = tokio::io::split(ours);
    let mut lines = LineReader::new(r);
    let n = nonce();
    write_line(&mut w, &json!({ "type": "hello", "nonce": n })).await.unwrap();
    let hello = lines.next().await.unwrap();
    assert_eq!(hello["proof"], proof("secret-token", "app", &n), "the program proves itself first");
    write_line(&mut w, &json!({ "type": "auth", "proof": proof("secret-token", "host", hello["nonce"].as_str().unwrap()), "browser": "edge" })).await.unwrap();
    assert_eq!(lines.next().await.unwrap()["type"], "ready");
    write_line(&mut w, &json!({ "id": 7, "type": "capture", "body": { "url": "http://127.0.0.1:1/b.zip", "kind": "menu", "headers": { "Cookie": "a=1", "X-Other": "no" } } })).await.unwrap();
    let reply = lines.next().await.unwrap();
    assert_eq!((reply["id"].clone(), reply["result"]["accepted"].clone()), (json!(7), json!(true)));
    assert_eq!(b.live().get("edge"), Some(&1));
    let item = m.list().into_iter().find(|i| i.url.ends_with("b.zip")).unwrap();
    let headers = m.headers_for(&item);
    assert!(headers.iter().any(|(k, v)| k == "Cookie" && v == "a=1"));
    assert!(!headers.iter().any(|(k, _)| k == "X-Other"), "only cookie, referer, user-agent and language are forwarded");

    // a wrong proof closes the connection without an answer
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    tokio::spawn(b.clone().serve_conn(theirs));
    let (r, mut w) = tokio::io::split(ours);
    let mut lines = LineReader::new(r);
    write_line(&mut w, &json!({ "type": "hello", "nonce": nonce() })).await.unwrap();
    let hello = lines.next().await.unwrap();
    write_line(&mut w, &json!({ "type": "auth", "proof": proof("guess", "host", hello["nonce"].as_str().unwrap()) })).await.unwrap();
    write_line(&mut w, &json!({ "id": 1, "type": "ping" })).await.ok();
    assert!(lines.next().await.is_none());
}
