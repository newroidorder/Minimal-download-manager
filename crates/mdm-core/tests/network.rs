use mdm_core::http::{build_client, open};
use mdm_core::rules::basic;
use mdm_core::settings::defaults;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// A forward HTTP proxy that answers every request itself and records it.
fn fake_proxy() -> (u16, Arc<Mutex<Vec<(String, Option<String>)>>>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let seen = Arc::new(Mutex::new(vec![]));
    let s = seen.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let auth = req.headers().iter().find(|h| h.field.equiv("Proxy-Authorization")).map(|h| h.value.to_string());
            s.lock().unwrap().push((req.url().to_string(), auth));
            let _ = req.respond(tiny_http::Response::from_string("via proxy"));
        }
    });
    (port, seen)
}

#[tokio::test]
async fn manual_http_proxy_with_login() {
    let (port, seen) = fake_proxy();
    let mut p = defaults(std::path::Path::new("C:\\d")).proxy;
    p.mode = "manual".into();
    p.host = "127.0.0.1".into();
    p.port = port as u32;
    p.user = "me".into();
    p.pass = "pw".into();
    let mut o = open(&build_client(&p, None), "http://files.example.invalid/a.zip", &vec![], &CancellationToken::new()).await.unwrap();
    assert_eq!(&o.res.chunk().await.unwrap().unwrap()[..], b"via proxy");
    let (target, auth) = seen.lock().unwrap()[0].clone();
    assert_eq!(target, "http://files.example.invalid/a.zip", "absolute-URI request to the proxy");
    assert_eq!(auth, Some(basic("me", "pw")));

    // mode "none" ignores the proxy settings
    p.mode = "none".into();
    assert!(open(&build_client(&p, None), "http://files.example.invalid/a.zip", &vec![], &CancellationToken::new()).await.is_err());
}
