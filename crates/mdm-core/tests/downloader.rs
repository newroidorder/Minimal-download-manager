mod common;

use common::*;
use mdm_core::downloader::{download, Control, Job, Options, Outcome, Stop};
use mdm_core::http::build_client;
use mdm_core::settings::defaults;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering::SeqCst;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn opts(dir: &Path) -> Options {
    let mut o = Options::new(build_client(&defaults(dir).proxy, None), dir.to_path_buf());
    o.retry_base = Duration::from_millis(10);
    o.progress_interval = Duration::from_millis(20);
    o.state_interval = Duration::from_millis(50);
    o
}

fn job(url: String, name: Option<&str>) -> Job {
    Job { url, filename: name.map(String::from), headers: vec![], dir: None, dest: None }
}

fn done(o: Result<Outcome, mdm_core::downloader::DlError>) -> PathBuf {
    match o {
        Ok(Outcome::Done { dest, .. }) => dest,
        other => panic!("expected done, got {other:?}"),
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

#[tokio::test(flavor = "multi_thread")]
async fn downloader() {
    let origin = start_origin();
    let o = &origin;

    // ranged file: parallel segments, hash matches, no leftovers
    let dir = tmp_dir();
    let dest = done(download(job(format!("{}/ranged", o.base), Some("big.bin")), opts(dir.path()), &Control::default()).await);
    assert_eq!(sha256(&std::fs::read(&dest).unwrap()), sha256(&BODY));
    let max = o.stats.max_open.load(SeqCst);
    assert!(max >= 4, "expected >= 4 parallel connections, saw {max}");
    assert!(leftovers(dir.path()).is_empty());

    // dropped connections are retried from the last written byte
    let dir = tmp_dir();
    let dest = done(download(job(format!("{}/flaky", o.base), Some("flaky.bin")), opts(dir.path()), &Control::default()).await);
    assert_eq!(o.stats.flaky_drops.load(SeqCst), 3);
    assert_eq!(sha256(&std::fs::read(&dest).unwrap()), sha256(&BODY));

    // server that advertises but ignores Range: single stream, correct size
    let dir = tmp_dir();
    let dest = done(download(job(format!("{}/ignores-range", o.base), Some("big.bin")), opts(dir.path()), &Control::default()).await);
    assert_eq!(sha256(&std::fs::read(&dest).unwrap()), sha256(&BODY));

    // HTTP 404 is an error and leaves nothing on disk
    let dir = tmp_dir();
    let err = download(job(format!("{}/missing", o.base), Some("file.zip")), opts(dir.path()), &Control::default()).await.unwrap_err();
    assert_eq!(err.message, "HTTP 404");
    assert!(names(dir.path()).is_empty());

    // cookies are dropped on cross-origin redirects, kept on same-origin
    let dir = tmp_dir();
    let mut j = job(format!("{}/redirect-cross", o.base), None);
    j.headers = vec![("Cookie".into(), "session=SECRET".into())];
    let cross = done(download(j, opts(dir.path()), &Control::default()).await);
    assert_eq!(std::fs::read_to_string(cross).unwrap(), "cookie: none");
    let mut j = job(format!("{}/redirect-same", o.base), None);
    j.headers = vec![("Cookie".into(), "session=SECRET".into())];
    let same = done(download(j, opts(dir.path()), &Control::default()).await);
    assert_eq!(std::fs::read_to_string(same).unwrap(), "cookie: session=SECRET");

    // Content-Disposition filename* is honored
    let dir = tmp_dir();
    let dest = done(download(job(format!("{}/attach?id=7", o.base), None), opts(dir.path()), &Control::default()).await);
    assert_eq!(dest.file_name().unwrap(), "résumé.pdf");

    // same name: concurrent and later downloads never overwrite
    let dir = tmp_dir();
    let runs = (0..3).map(|_| {
        let o = opts(dir.path());
        let url = format!("{}/small.txt", origin.base);
        async move { download(job(url, Some("same.txt")), o, &Control::default()).await }
    });
    for r in futures_util::future::join_all(runs).await {
        done(r);
    }
    assert_eq!(names(dir.path()), ["same (1).txt", "same (2).txt", "same.txt"]);

    // cancel removes the .part file
    let dir = tmp_dir();
    let c = Arc::new(Control::default());
    let c2 = c.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        c2.stop(Stop::Cancelled);
    });
    let r = download(job(format!("{}/slow", o.base), Some("c.bin")), opts(dir.path()), &c).await.unwrap();
    assert!(matches!(r, Outcome::Cancelled));
    assert!(names(dir.path()).is_empty());

    // pause keeps progress; resume continues without re-downloading
    let dir = tmp_dir();
    let c = Arc::new(Control::default());
    let c2 = c.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        c2.stop(Stop::Paused);
    });
    let paused_at = Arc::new(Mutex::new(0u64));
    let mut op = opts(dir.path());
    let pa = paused_at.clone();
    op.on_progress = Arc::new(move |p| *pa.lock().unwrap() = p.received);
    let Outcome::Paused { dest: Some(dest), .. } = download(job(format!("{}/slow", o.base), Some("p.bin")), op, &c).await.unwrap() else { panic!("not paused") };
    let at = *paused_at.lock().unwrap();
    assert!(at > 0 && at < BODY.len() as u64, "paused mid-way ({at} bytes)");
    assert!(Path::new(&format!("{}.part", dest.display())).exists() && Path::new(&format!("{}.part.json", dest.display())).exists());
    tokio::time::sleep(Duration::from_millis(500)).await; // let requests from earlier cases reach the server log
    o.stats.range_starts.lock().unwrap().clear();
    let first = Arc::new(Mutex::new(None::<u64>));
    let mut op = opts(dir.path());
    let f2 = first.clone();
    op.on_progress = Arc::new(move |p| {
        f2.lock().unwrap().get_or_insert(p.received);
    });
    let mut j = job(format!("{}/slow", o.base), Some("p.bin"));
    j.dest = Some(dest.clone());
    let d = done(download(j, op, &Control::default()).await);
    assert_eq!(sha256(&std::fs::read(&d).unwrap()), sha256(&BODY));
    assert!(!o.stats.range_starts.lock().unwrap().contains(&0), "resume must not restart from byte 0: {:?}", o.stats.range_starts.lock().unwrap());
    assert!(first.lock().unwrap().unwrap() > 0, "resume reports the bytes it already had");
    assert!(leftovers(dir.path()).is_empty());

    // error on a ranged download keeps the .part so a retry resumes
    let dir = tmp_dir();
    let c = Arc::new(Control::default());
    let c2 = c.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        c2.stop(Stop::Failed("network down".into()));
    });
    let err = download(job(format!("{}/slow", o.base), Some("e.bin")), opts(dir.path()), &c).await.unwrap_err();
    assert_eq!(err.message, "network down");
    let dest = err.dest.expect("kept");
    assert!(Path::new(&format!("{}.part.json", dest.display())).exists());
    let mut j = job(format!("{}/slow", o.base), Some("e.bin"));
    j.dest = Some(dest);
    let d = done(download(j, opts(dir.path()), &Control::default()).await);
    assert_eq!(sha256(&std::fs::read(&d).unwrap()), sha256(&BODY));

    // a stop while the resume is still connecting keeps (pause) or deletes (cancel) the .part
    let dir = tmp_dir();
    let dest = dir.path().join("r.bin");
    let (p, s) = (format!("{}.part", dest.display()), format!("{}.part.json", dest.display()));
    let url = format!("{}/slow", o.base);
    for (why, kept) in [(Stop::Paused, true), (Stop::Failed("offline".into()), true), (Stop::Cancelled, false)] {
        std::fs::write(&p, b"partial").unwrap();
        std::fs::write(&s, serde_json::json!({ "url": url, "size": BODY.len(), "segments": [{ "start": 0, "pos": 7, "end": BODY.len() - 1 }] }).to_string()).unwrap();
        let c = Control::default();
        c.stop(why.clone());
        let mut j = job(url.clone(), None);
        j.dest = Some(dest.clone());
        let r = download(j, opts(dir.path()), &c).await;
        match (&why, &r) {
            (Stop::Paused, Ok(Outcome::Paused { dest: Some(d), .. })) => assert_eq!(d, &dest),
            (Stop::Failed(_), Err(e)) => assert_eq!(e.dest.as_ref(), Some(&dest)),
            (Stop::Cancelled, Ok(Outcome::Cancelled)) => {}
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(Path::new(&p).exists() && Path::new(&s).exists(), kept, "{why:?}");
        assert_eq!(std::fs::read(&p).ok().as_deref() == Some(&b"partial"[..]), kept, "{why:?} must not touch the data");
    }
}
