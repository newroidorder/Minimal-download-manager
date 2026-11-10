mod common;

use chrono::{Local, TimeZone};
use common::*;
use mdm_core::http::build_client;
use mdm_core::manager::{AddOpts, Event, Item, Manager, ManagerConfig};
use mdm_core::scheduler::Scheduler;
use mdm_core::settings::{defaults, SettingsStore};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering::SeqCst;
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct T {
    m: Manager,
    base: PathBuf,
    home: PathBuf,
    events: Arc<Mutex<Vec<Event>>>,
    _dir: Option<tempfile::TempDir>,
}

fn make_in(home: &Path, settings: Value, scanned: Option<Arc<Mutex<Vec<(String, String, String)>>>>) -> T {
    let base = home.join("Downloads");
    let store = Arc::new(SettingsStore::new(Some(home.join("settings.json")), base.clone(), None));
    store.update(&settings).unwrap();
    let run_program: Option<mdm_core::manager::RunProgram> = scanned.map(|s| {
        Arc::new(move |p: String, a: String, f: String| {
            s.lock().unwrap().push((p, a, f));
            Box::pin(async { Ok::<i32, String>(0) }) as std::pin::Pin<Box<dyn std::future::Future<Output = Result<i32, String>> + Send>>
        }) as mdm_core::manager::RunProgram
    });
    let (m, mut rx) = Manager::new(ManagerConfig {
        client: build_client(&defaults(&base).proxy, None),
        settings: store,
        state_file: Some(home.join("list.json")),
        run_program,
        tweak: Some(Arc::new(|o| {
            o.retry_base = Duration::from_millis(10);
            o.progress_interval = Duration::from_millis(20);
            o.state_interval = Duration::from_millis(50);
        })),
        rt: tokio::runtime::Handle::current(),
    });
    let events = Arc::new(Mutex::new(vec![]));
    let ev = events.clone();
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            ev.lock().unwrap().push(e);
        }
    });
    T { m, base, home: home.to_path_buf(), events, _dir: None }
}

fn make(settings: Value) -> T {
    let dir = tmp_dir();
    let mut t = make_in(dir.path(), settings, None);
    t._dir = Some(dir);
    t
}

async fn wait_for<F: Fn() -> bool>(f: F, what: &str) {
    for _ in 0..1500 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

impl T {
    async fn status(&self, id: &str, s: &str) -> Item {
        wait_for(|| self.m.get(id).is_some_and(|i| i.status == s), &format!("status {s}")).await;
        self.m.get(id).unwrap()
    }
    fn add(&self, v: Value) -> mdm_core::manager::AddResult {
        let o: AddOpts = serde_json::from_value(v).unwrap();
        self.m.add(o).unwrap()
    }
    fn has(&self, f: impl Fn(&Event) -> bool) -> bool {
        self.events.lock().unwrap().iter().any(f)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn manager() {
    let origin = start_origin();
    let u = |p: &str| format!("{}{p}", origin.base);

    // automatic downloads go to their category folder
    let t = make(json!({}));
    let item = t.add(json!({ "url": u("/small.txt"), "filename": "song.mp3" })).item.unwrap();
    let done = t.status(&item.id, "done").await;
    assert_eq!(PathBuf::from(done.dest.unwrap()), t.base.join("Music").join("song.mp3"));
    assert_eq!(done.category, "music");
    assert!(done.last_try_at.is_some() && done.finished_at.is_some());
    wait_for(|| t.has(|e| matches!(e, Event::Complete(i) if i.id == item.id)), "complete event").await;

    // "New download": pending until confirmed, folder remembered per category
    let t = make(json!({}));
    let item = t.add(json!({ "url": u("/attach?id=7"), "interactive": true })).item.unwrap();
    assert_eq!(item.status, "pending");
    wait_for(|| t.m.get(&item.id).is_some_and(|i| !i.inspecting), "inspect").await;
    let info = t.m.get(&item.id).unwrap();
    assert_eq!((info.filename.as_str(), info.size, info.category.as_str()), ("résumé.pdf", 5, "documents"));
    assert!(t.m.confirm(&item.id, &json!({ "dir": "relative" })).unwrap_err().contains("full folder path"));
    let chosen = t.home.join("Papers");
    t.m.confirm(&item.id, &json!({ "dir": chosen.display().to_string(), "filename": "cv.pdf", "description": "my CV" })).unwrap();
    let done = t.status(&item.id, "done").await;
    assert_eq!(PathBuf::from(done.dest.unwrap()), chosen.join("cv.pdf"));
    assert_eq!(done.description, "my CV");
    assert_eq!(t.m.settings().categorize("x.pdf", "").folder, chosen.display().to_string());

    // "Download Later" puts it in the main queue; starting the queue runs files in order
    let t = make(json!({}));
    let a = t.add(json!({ "url": u("/small.txt"), "filename": "a.txt", "start": false })).item.unwrap();
    let b = t.add(json!({ "url": u("/attach?id=7"), "filename": "b.pdf", "start": false })).item.unwrap();
    assert_eq!(a.queue_id.as_deref(), Some("main"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(t.m.get(&a.id).unwrap().status, "queued");
    t.m.start_queue("main");
    t.status(&a.id, "done").await;
    t.status(&b.id, "done").await;
    let order: Vec<String> = t.events.lock().unwrap().iter().filter_map(|e| match e { Event::Update(i) if i.status == "starting" => Some(i.id.clone()), _ => None }).collect();
    assert_eq!(order, [a.id.clone(), b.id.clone()]);
    wait_for(|| t.has(|e| matches!(e, Event::QueueEnd(..))), "queueEnd").await;
    assert!(t.m.running_queues().is_empty());

    // scheduler starts and stops queues at the set times
    let t = make(json!({ "queues": [{ "id": "main", "schedule": { "enabled": true, "startMode": "daily", "startTime": "03:00", "days": [1], "stopEnabled": true, "stopTime": "05:30" } }] }));
    t.add(json!({ "url": u("/slow"), "filename": "s.bin", "start": false }));
    let sched = Scheduler::new(t.m.clone());
    sched.tick_at(Local.with_ymd_and_hms(2026, 10, 12, 2, 59, 30).unwrap());
    assert!(t.m.running_queues().is_empty());
    sched.tick_at(Local.with_ymd_and_hms(2026, 10, 12, 3, 0, 5).unwrap());
    assert_eq!(t.m.running_queues(), ["main"]);
    sched.tick_at(Local.with_ymd_and_hms(2026, 10, 12, 5, 30, 1).unwrap());
    assert!(t.m.running_queues().is_empty());
    sched.tick_at(Local.with_ymd_and_hms(2026, 10, 13, 3, 0, 0).unwrap());
    assert!(t.m.running_queues().is_empty());
    t.m.close().await;

    // failed downloads retry after the configured delay; 404s do not
    let t = make(json!({ "retry": { "attempts": 3, "delay": 1 } }));
    let item = t.add(json!({ "url": u("/fail-twice"), "filename": "retry.bin" })).item.unwrap();
    t.status(&item.id, "done").await;
    assert_eq!(origin.stats.fail_hits.load(SeqCst), 3);
    let missing = t.add(json!({ "url": u("/missing"), "filename": "x.zip" })).item.unwrap();
    t.status(&missing.id, "error").await;
    tokio::time::sleep(Duration::from_millis(1300)).await;
    let m = t.m.get(&missing.id).unwrap();
    assert_eq!((m.status.as_str(), m.retries), ("error", 0));

    // duplicate links: ask, numbered copy, overwrite, resume
    let t = make(json!({}));
    let first = t.add(json!({ "url": u("/small.txt"), "filename": "dup.txt" })).item.unwrap();
    t.status(&first.id, "done").await;
    assert_eq!(t.add(json!({ "url": u("/small.txt") })).duplicate.unwrap().id, first.id);
    let numbered = t.add(json!({ "url": u("/small.txt"), "filename": "dup.txt", "duplicate": "number" })).item.unwrap();
    assert!(t.status(&numbered.id, "done").await.dest.unwrap().ends_with("dup (1).txt"));
    assert!(t.add(json!({ "url": u("/small.txt"), "duplicate": "resume" })).existing);
    let over = t.add(json!({ "url": u("/attach?id=7"), "filename": "over.pdf" })).item.unwrap();
    t.status(&over.id, "done").await;
    let replaced = t.add(json!({ "url": u("/attach?id=7"), "duplicate": "overwrite" })).item.unwrap();
    assert!(t.status(&replaced.id, "done").await.dest.unwrap().ends_with("over.pdf"));
    assert!(t.m.get(&over.id).is_none());

    // site logins: never over plain HTTP unless entered as http://
    let t = make(json!({ "sites": [{ "site": "127.0.0.1", "user": "me", "pass": "secret" }] }));
    let refused = t.add(json!({ "url": u("/needs-auth"), "filename": "refused.txt" })).item.unwrap();
    t.status(&refused.id, "error").await;
    assert_eq!(origin.stats.auth.lock().unwrap().last().unwrap(), &None);
    let t = make(json!({ "sites": [{ "site": "http://127.0.0.1", "user": "me", "pass": "secret" }] }));
    let item = t.add(json!({ "url": u("/needs-auth"), "filename": "private.txt" })).item.unwrap();
    let done = t.status(&item.id, "done").await;
    assert_eq!(std::fs::read_to_string(done.dest.unwrap()).unwrap(), "private");

    // per-server connection limit
    let t = make(json!({ "connection": { "exceptions": [{ "host": "127.0.0.1", "max": 2 }] } }));
    origin.stats.max_open.store(0, SeqCst);
    let item = t.add(json!({ "url": u("/ranged"), "filename": "two.bin" })).item.unwrap();
    let done = t.status(&item.id, "done").await;
    assert_eq!(sha256(&std::fs::read(done.dest.unwrap()).unwrap()), sha256(&BODY));
    assert!(origin.stats.max_open.load(SeqCst) <= 2);

    // download quota pauses everything and warns
    let t = make(json!({ "connection": { "quota": { "enabled": true, "mb": 2, "hours": 1, "warn": true } } }));
    let item = t.add(json!({ "url": u("/slow"), "filename": "quota.bin" })).item.unwrap();
    wait_for(|| t.has(|e| matches!(e, Event::Quota { .. })), "quota").await;
    assert!(t.has(|e| matches!(e, Event::QuotaWarning { .. })));
    t.status(&item.id, "queued").await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(t.m.get(&item.id).unwrap().status, "queued");

    // file date from the server and antivirus check
    let dir = tmp_dir();
    let scanned = Arc::new(Mutex::new(vec![]));
    let t = make_in(dir.path(), json!({ "save": { "setFileDate": true }, "downloads": { "antivirus": { "enabled": true, "program": "scanner.exe", "args": "/scan \"%f\"" } } }), Some(scanned.clone()));
    let item = t.add(json!({ "url": u("/lastmod.bin") })).item.unwrap();
    let done = t.status(&item.id, "done").await;
    let dest = done.dest.unwrap();
    let mtime: chrono::DateTime<chrono::Utc> = std::fs::metadata(&dest).unwrap().modified().unwrap().into();
    assert_eq!(mtime.to_rfc3339(), "2020-01-01T10:00:00+00:00");
    assert_eq!(scanned.lock().unwrap().clone(), [("scanner.exe".to_string(), "/scan \"%f\"".to_string(), dest)]);
    assert_eq!(done.scan.as_deref(), Some("clean"));

    // stop all, edit, resume, redownload, remove completed, remove
    let t = make(json!({}));
    let a = t.add(json!({ "url": u("/slow"), "filename": "a.bin" })).item.unwrap();
    let b = t.add(json!({ "url": u("/slow"), "filename": "b.bin", "duplicate": "number" })).item.unwrap();
    wait_for(|| t.m.get(&a.id).unwrap().received > 0 && t.m.get(&b.id).unwrap().received > 0, "both running").await;
    t.m.stop_all();
    t.status(&a.id, "paused").await;
    t.status(&b.id, "paused").await;
    assert!(t.m.edit(&a.id, None, Some("ftp://x")).unwrap_err().contains("http"));
    t.m.edit(&a.id, Some("moved"), Some(&u("/ranged"))).unwrap();
    t.m.resume(&a.id);
    let done = t.status(&a.id, "done").await;
    assert_eq!(done.description, "moved");
    assert_eq!(sha256(&std::fs::read(done.dest.unwrap()).unwrap()), sha256(&BODY));
    t.m.redownload(&a.id).await;
    t.status(&a.id, "done").await;
    assert_eq!(t.m.remove_completed(), 1);
    assert!(t.m.get(&a.id).is_none());
    t.m.remove(&b.id, false).await;
    assert!(t.m.list().is_empty());

    // the list survives a restart; interrupted downloads come back paused
    let dir = tmp_dir();
    let first = make_in(dir.path(), json!({}), None);
    let item = first.add(json!({ "url": u("/slow"), "filename": "restart.bin" })).item.unwrap();
    wait_for(|| first.m.get(&item.id).unwrap().received > 0, "progress").await;
    first.m.close().await;
    let second = make_in(dir.path(), json!({}), None);
    let back = second.m.get(&item.id).unwrap();
    assert_eq!(back.status, "paused");
    assert!(Path::new(&format!("{}.part.json", back.dest.unwrap())).exists());
    second.m.resume(&item.id);
    let done = second.status(&item.id, "done").await;
    assert_eq!(sha256(&std::fs::read(done.dest.unwrap()).unwrap()), sha256(&BODY));
}
