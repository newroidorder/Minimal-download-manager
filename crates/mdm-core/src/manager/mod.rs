//! The download manager: the list, queues, limits, retries and the rules from
//! Options. The desktop UI and the browser bridge both drive it.
//!
//! Statuses: pending (waiting for the "New download" window), queued, starting,
//! downloading, scanning (antivirus), paused, done, error, cancelled.
//! Request headers (cookies) live in memory only and are never written to disk.

mod actions;
mod run;

use crate::downloader::{Control, Options};
use crate::http::{filename_from_url, sanitize, Headers};
use crate::limiter::Limiter;
use crate::rules::{credentials_for, host_matches};
use crate::settings::{ext_of, Queue, SettingsStore};
use crate::now_ms;
use indexmap::IndexMap;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, RwLock, Weak};
use tokio::runtime::Handle;
use tokio::sync::{mpsc, Notify};
use tokio::task::AbortHandle;
use url::Url;

pub const ACTIVE: [&str; 2] = ["starting", "downloading"];
pub const BUSY: [&str; 3] = ["starting", "downloading", "scanning"];
const LIVE_ONLY: [&str; 4] = ["segments", "inspecting", "speed", "connections"];

pub fn is_active(s: &str) -> bool {
    ACTIVE.contains(&s)
}
pub fn is_busy(s: &str) -> bool {
    BUSY.contains(&s)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub id: String,
    pub url: String,
    pub referrer: String,
    pub requested_name: Option<String>,
    pub filename: String,
    pub category: String,
    pub dir: Option<String>,
    pub dest: Option<String>,
    pub mime: String,
    pub status: String,
    pub queue_id: Option<String>,
    pub queue_order: u64,
    pub inspecting: bool,
    pub inspect_error: Option<String>,
    pub size: u64,
    pub received: u64,
    pub progress: u8,
    pub speed: u64,
    pub connections: usize,
    pub error: Option<String>,
    pub description: String,
    pub kind: String,
    pub retries: u32,
    pub added_at: i64,
    pub last_try_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub overwrite: bool,
    pub resumable: bool,
    pub segments: Vec<[u64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan: Option<String>,
    #[serde(skip)]
    pub quota_paused: bool,
}

#[derive(Clone, Debug)]
pub enum Event {
    Update(Item),
    Remove(String),
    Queues(Vec<String>),
    Complete(Item),
    Failed(Item),
    QueueStart(Option<Queue>),
    QueueEnd(Option<Queue>, String),
    Quota { until: i64 },
    QuotaWarning { mb: u64, hours: u64 },
}

/// What a window or the browser asks to add.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AddOpts {
    pub url: String,
    pub filename: Option<String>,
    #[serde(skip)]
    pub headers: Headers,
    pub referrer: Option<String>,
    pub description: Option<String>,
    pub interactive: bool,
    pub kind: Option<String>,
    pub dir: Option<String>,
    pub queue_id: Option<String>,
    pub start: Option<bool>,
    pub duplicate: Option<String>,
}

#[derive(Debug, Default)]
pub struct AddResult {
    pub item: Option<Item>,
    /// The duplicate rule is "ask": the UI must ask about this existing item.
    pub duplicate: Option<Item>,
    pub existing: bool,
}

pub type RunProgram = Arc<dyn Fn(String, String, String) -> Pin<Box<dyn Future<Output = Result<i32, String>> + Send>> + Send + Sync>;
pub type Tweak = Arc<dyn Fn(&mut Options) + Send + Sync>;

pub struct ManagerConfig {
    pub settings: Arc<SettingsStore>,
    pub state_file: Option<PathBuf>,
    pub client: Client,
    pub run_program: Option<RunProgram>,
    /// Tests use this to speed up retries and timers.
    pub tweak: Option<Tweak>,
    pub rt: Handle,
}

#[derive(Default)]
struct QuotaState {
    window_start: i64,
    bytes: u64,
    blocked: bool,
    warned: bool,
    timer: Option<AbortHandle>,
}

#[derive(Default)]
struct State {
    items: IndexMap<String, Item>,
    secrets: HashMap<String, Headers>,
    controllers: HashMap<String, Arc<Control>>,
    retry: HashMap<String, AbortHandle>,
    running_queues: Vec<String>,
    quota: QuotaState,
    persist_pending: bool,
}

pub struct Inner {
    settings: Arc<SettingsStore>,
    state_file: Option<PathBuf>,
    client: RwLock<Client>,
    run_program: Option<RunProgram>,
    tweak: Option<Tweak>,
    rt: Handle,
    tx: mpsc::UnboundedSender<Event>,
    st: Mutex<State>,
    idle: Notify,
    limiter: Arc<Limiter>,
}

#[derive(Clone)]
pub struct Manager(Arc<Inner>);

impl Manager {
    /// Events arrive on the returned channel, never while the list is locked.
    pub fn new(cfg: ManagerConfig) -> (Manager, mpsc::UnboundedReceiver<Event>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let m = Manager(Arc::new(Inner {
            settings: cfg.settings.clone(),
            state_file: cfg.state_file,
            client: RwLock::new(cfg.client),
            run_program: cfg.run_program,
            tweak: cfg.tweak,
            rt: cfg.rt,
            tx,
            st: Mutex::new(State { quota: QuotaState { window_start: now_ms(), ..Default::default() }, ..Default::default() }),
            idle: Notify::new(),
            limiter: Arc::new(Limiter::default()),
        }));
        m.apply_limits();
        let weak: Weak<Inner> = Arc::downgrade(&m.0);
        cfg.settings.on_change(move |_| {
            if let Some(inner) = weak.upgrade() {
                let m = Manager(inner);
                m.apply_limits();
                m.pump();
            }
        });
        m.load();
        (m, rx)
    }

    pub fn settings(&self) -> &Arc<SettingsStore> {
        &self.0.settings
    }

    pub fn client(&self) -> Client {
        self.0.client.read().unwrap().clone()
    }

    /// New proxy settings: later requests use the new client.
    pub fn set_client(&self, c: Client) {
        *self.0.client.write().unwrap() = c;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.st.lock().unwrap()
    }

    fn emit(&self, e: Event) {
        let _ = self.0.tx.send(e);
    }

    fn apply_limits(&self) {
        let sl = self.0.settings.get().speed_limit.clone();
        self.0.limiter.set(if sl.enabled { sl.kbps * 1024 } else { 0 });
    }

    // ---------- list ----------

    fn load(&self) {
        let Some(file) = &self.0.state_file else { return };
        let Ok(text) = std::fs::read_to_string(file) else { return };
        let Ok(saved) = serde_json::from_str::<Vec<serde_json::Value>>(&text) else { return };
        let mut st = self.lock();
        for v in saved {
            let Ok(mut item) = serde_json::from_value::<Item>(v) else { continue };
            if item.id.is_empty() {
                continue;
            }
            // Interrupted by a restart: hold it so the user can resume. Cookies are gone.
            if is_active(&item.status) {
                item.status = "paused".into();
            }
            if item.status == "scanning" {
                item.status = "done".into();
            }
            item.speed = 0;
            item.connections = 0;
            item.inspecting = false;
            st.items.insert(item.id.clone(), item);
        }
        drop(st);
        let m = self.clone();
        self.0.rt.spawn(async move { m.pump() });
    }

    pub fn list(&self) -> Vec<Item> {
        let mut v: Vec<Item> = self.lock().items.values().cloned().collect();
        v.sort_by(|a, b| b.added_at.cmp(&a.added_at));
        v
    }

    pub fn get(&self, id: &str) -> Option<Item> {
        self.lock().items.get(id).cloned()
    }

    pub fn running_queues(&self) -> Vec<String> {
        self.lock().running_queues.clone()
    }

    fn update(&self, st: &mut State, id: &str, persist: bool, f: impl FnOnce(&mut Item)) -> Option<Item> {
        let item = st.items.get_mut(id)?;
        f(item);
        let copy = item.clone();
        self.emit(Event::Update(copy.clone()));
        if persist {
            self.persist(st);
        }
        self.0.idle.notify_waiters();
        Some(copy)
    }

    // ---------- adding ----------

    pub fn find_duplicate(&self, url: &str) -> Option<Item> {
        self.lock().items.values().find(|i| i.url == url && i.status != "cancelled").cloned()
    }

    pub fn add(&self, opts: AddOpts) -> Result<AddResult, String> {
        let u = Url::parse(opts.url.trim()).map_err(|_| "invalid address".to_string())?;
        if u.scheme() != "http" && u.scheme() != "https" {
            return Err("only http and https addresses are supported".into());
        }
        let href = u.to_string();
        let s = self.0.settings.get();
        let mut overwrite_of: Option<Item> = None;
        if let Some(existing) = self.find_duplicate(&href) {
            let action = opts.duplicate.clone().unwrap_or_else(|| s.downloads.duplicate.clone());
            match action.as_str() {
                "ask" => return Ok(AddResult { duplicate: Some(existing), ..Default::default() }),
                "resume" => {
                    if existing.status != "done" {
                        self.resume(&existing.id);
                    }
                    if !opts.headers.is_empty() {
                        self.lock().secrets.insert(existing.id.clone(), opts.headers.clone());
                    }
                    return Ok(AddResult { item: self.get(&existing.id), existing: true, ..Default::default() });
                }
                "overwrite" => overwrite_of = Some(existing),
                _ => {}
            }
        }

        let requested = match (&opts.filename, &overwrite_of) {
            (Some(f), _) if !f.is_empty() => Some(sanitize(f)),
            (_, Some(o)) => Some(o.filename.clone()),
            _ => None,
        };
        let name = requested.clone().or_else(|| filename_from_url(&href)).unwrap_or_else(|| u.host_str().unwrap_or("").to_string());
        let ask = opts.interactive && s.downloads.show_file_info;
        let later = opts.start == Some(false);
        let queue_id = if !ask && later { Some(opts.queue_id.clone().unwrap_or_else(|| "main".into())) } else { opts.queue_id.clone() };
        let id = uuid::Uuid::new_v4().to_string();
        let mut item = Item {
            id: id.clone(),
            url: href,
            referrer: opts.referrer.as_deref().unwrap_or("").chars().take(2000).collect(),
            requested_name: requested,
            category: crate::settings::categorize(&s, &name, "").id.clone(),
            filename: name,
            dir: opts.dir.clone().filter(|d| !d.is_empty()).or_else(|| overwrite_of.as_ref().and_then(|o| o.dir.clone())),
            status: if ask { "pending" } else { "queued" }.into(),
            queue_id,
            inspecting: ask,
            description: opts.description.as_deref().unwrap_or("").chars().take(500).collect(),
            kind: opts.kind.clone().unwrap_or_else(|| "manual".into()),
            added_at: now_ms(),
            overwrite: overwrite_of.is_some(),
            ..Default::default()
        };
        let mut st = self.lock();
        if let Some(q) = item.queue_id.clone() {
            item.queue_order = next_order(&st, &q);
        }
        if let Some(o) = &overwrite_of {
            // "Add the duplicate and overwrite the existing file"
            if let Some(d) = &o.dest {
                for f in [d.clone(), format!("{d}.part"), format!("{d}.part.json")] {
                    let _ = std::fs::remove_file(f);
                }
            }
            if is_busy(&o.status) {
                if let Some(c) = st.controllers.get(&o.id) {
                    c.stop(crate::downloader::Stop::Cancelled);
                }
            }
            self.forget_locked(&mut st, &o.id);
        }
        st.items.insert(id.clone(), item.clone());
        if !opts.headers.is_empty() {
            st.secrets.insert(id.clone(), opts.headers.clone());
        }
        self.emit(Event::Update(item.clone()));
        self.persist(&mut st);
        drop(st);
        if ask {
            self.inspect_item(id);
        } else {
            self.pump();
        }
        Ok(AddResult { item: Some(item), ..Default::default() })
    }

    pub fn headers_for(&self, item: &Item) -> Headers {
        let mut h = self.lock().secrets.get(&item.id).cloned().unwrap_or_default();
        let s = self.0.settings.get();
        let has = |h: &Headers, n: &str| h.iter().any(|(k, _)| k.eq_ignore_ascii_case(n));
        if !has(&h, "user-agent") {
            h.push(("User-Agent".into(), s.downloads.user_agent.clone()));
        }
        if !has(&h, "referer") && !item.referrer.is_empty() {
            h.push(("Referer".into(), item.referrer.clone()));
        }
        if !has(&h, "authorization") {
            if let Some(a) = credentials_for(&s.sites, &item.url) {
                h.push(("Authorization".into(), a));
            }
        }
        h
    }

    fn connections_for(&self, url: &str) -> u32 {
        let c = self.0.settings.get().connection.clone();
        let host = Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
        c.exceptions.iter().find(|e| host_matches(&e.host, &host)).map_or(c.max_connections, |e| e.max)
    }

    /// Fills in name, size, type, category and folder for the "New download" window.
    fn inspect_item(&self, id: String) {
        let m = self.clone();
        self.0.rt.spawn(async move {
            let Some(item) = m.get(&id) else { return };
            let headers = m.headers_for(&item);
            let r = crate::http::inspect(&m.client(), &item.url, &headers).await;
            let mut st = m.lock();
            let Some(cur) = st.items.get(&id) else { return };
            if cur.status != "pending" {
                return;
            }
            let (mut filename, mut requested, mut mime, mut size, mut err) = (cur.filename.clone(), cur.requested_name.clone(), cur.mime.clone(), cur.size, None);
            match r {
                Ok(info) => {
                    size = info.size;
                    mime = info.mime;
                    match &requested {
                        None => filename = info.filename,
                        // A name without an extension (an ID from the address) loses to the server's real name.
                        Some(r) if ext_of(r).is_empty() && !ext_of(&info.filename).is_empty() => {
                            filename = info.filename.clone();
                            requested = Some(info.filename);
                        }
                        _ => {}
                    }
                }
                Err(e) => err = Some(e.message),
            }
            let cat = m.0.settings.categorize(&filename, &mime);
            m.update(&mut st, &id, true, |i| {
                i.inspecting = false;
                i.size = size;
                i.mime = mime;
                i.filename = filename;
                i.requested_name = requested;
                i.inspect_error = err;
                i.category = cat.id.clone();
                if i.dir.is_none() {
                    i.dir = Some(cat.folder.clone());
                }
            });
        });
    }

    /// The answer from the "New download" window: name, folder, start now or later.
    pub fn confirm(&self, id: &str, data: &serde_json::Value) -> Result<Option<Item>, String> {
        let s = self.0.settings.get();
        let mut st = self.lock();
        let Some(item) = st.items.get(id).cloned() else { return Ok(None) };
        if item.status != "pending" {
            return Err("this download is not waiting for confirmation".into());
        }
        let folder = data.get("dir").and_then(|d| d.as_str()).unwrap_or("").trim().to_string();
        if !crate::settings::is_abs(&folder) {
            return Err("choose a full folder path".into());
        }
        let name = data.get("filename").and_then(|f| f.as_str()).map(str::trim).filter(|f| !f.is_empty()).map(sanitize);
        let cats = &s.save.categories;
        let wanted = data.get("category").and_then(|c| c.as_str());
        let cat = cats.iter().find(|c| Some(c.id.as_str()) == wanted).or_else(|| cats.iter().find(|c| c.id == item.category)).cloned();
        let start = data.get("start").and_then(|v| v.as_bool()).unwrap_or(true);
        let queue = if start {
            None
        } else {
            let q = data.get("queueId").and_then(|q| q.as_str()).filter(|q| s.queues.iter().any(|x| x.id == *q)).unwrap_or("main").to_string();
            Some((next_order(&st, &q), q))
        };
        let description = data.get("description").and_then(|d| d.as_str()).map(|d| d.chars().take(500).collect::<String>());
        let updated = self.update(&mut st, id, true, |i| {
            i.dir = Some(folder.clone());
            i.status = "queued".into();
            i.inspecting = false;
            i.queue_id = None;
            if let Some(n) = name {
                i.requested_name = Some(n.clone());
                i.filename = n;
            }
            if let Some(c) = &cat {
                i.category = c.id.clone();
            }
            if let Some(d) = description {
                i.description = d;
            }
            if let Some((order, q)) = queue {
                i.queue_id = Some(q);
                i.queue_order = order;
            }
        });
        drop(st);
        // "Remember the last folder used for this category"
        if let Some(c) = cat.filter(|c| c.remember_last && c.folder != folder) {
            let cats: Vec<_> = s.save.categories.iter().map(|x| if x.id == c.id { serde_json::json!({ "id": x.id, "folder": folder }) } else { serde_json::json!({ "id": x.id }) }).collect();
            let _ = self.0.settings.update(&serde_json::json!({ "save": { "categories": cats } }));
        }
        self.pump();
        Ok(updated)
    }
}

fn next_order(st: &State, queue_id: &str) -> u64 {
    st.items.values().filter(|i| i.queue_id.as_deref() == Some(queue_id)).map(|i| i.queue_order).max().unwrap_or(0) + 1
}

