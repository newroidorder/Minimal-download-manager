//! All user settings, grouped like the Options tabs. Saved to
//! <home>/settings.json. Every value is validated against the defaults, so a
//! damaged or old file can never put the app in a bad state.

mod merge;

pub use merge::{clean_exts, is_abs, merge};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

pub const CAPTURE_EXTS: &str = "3gp 7z aac ace aif apk arj asf avi bin bz2 exe gz gzip img iso lzh m4a m4v mkv mov mp3 mp4 \
mpa mpe mpeg mpg msi msu ogg ogv pdf plj pps ppt qt r0 r1 ra rar rm rmvb sea sit sitx tar tif tiff wav wma wmv z zip \
flac webm opus xz zst dmg pkg deb rpm appimage msix epub torrent";

pub const EXCLUDE_SITES: [&str; 6] = ["*.update.microsoft.com", "download.windowsupdate.com", "*.download.windowsupdate.com", "siteseal.thawte.com", "ecom.cimetz.com", "*.voice2page.com"];

pub const CATEGORY_DEFAULTS: [(&str, &str, &str); 6] = [
    ("compressed", "Compressed", "zip rar 7z gz tgz bz2 xz tar arj ace cab lzh zst r0 r1 sit sitx sea z gzip"),
    ("documents", "Documents", "pdf doc docx xls xlsx ppt pptx pps odt ods odp rtf txt csv epub mobi plj"),
    ("music", "Music", "mp3 wav wma aac m4a flac ogg opus aif aiff mpa ra"),
    ("programs", "Programs", "exe msi msu msix appx apk dmg pkg deb rpm appimage iso img bin"),
    ("video", "Video", "mp4 mkv avi mov wmv flv webm m4v mpg mpeg mpe 3gp ts ogv asf rm rmvb qt"),
    ("general", "", ""),
];

pub const BROWSERS: [&str; 6] = ["chrome", "edge", "opera", "brave", "vivaldi", "firefox"];
pub const SOUND_EVENTS: [&str; 4] = ["complete", "failed", "queueStart", "queueEnd"];
pub const COLUMNS: [&str; 8] = ["name", "queue", "size", "status", "timeLeft", "rate", "lastTry", "description"];

fn words(s: &str) -> Vec<String> {
    s.split_whitespace().map(String::from).collect()
}

pub fn is_builtin_category(id: &str) -> bool {
    CATEGORY_DEFAULTS.iter().any(|c| c.0 == id)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    pub language: String,
    pub general: General,
    pub file_types: FileTypes,
    pub save: Save,
    pub downloads: Downloads,
    pub connection: Connection,
    pub proxy: Proxy,
    pub sites: Vec<Site>,
    pub retry: Retry,
    pub sounds: IndexMap<String, Sound>,
    pub speed_limit: SpeedLimit,
    pub ui: Ui,
    pub queues: Vec<Queue>,
    pub grabber_projects: Vec<GrabberProject>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct General {
    pub start_with_windows: bool,
    pub monitor_clipboard: bool,
    pub browsers: IndexMap<String, bool>,
    pub context_menu: bool,
    pub bypass_key: String,
    pub send_cookies: bool,
    pub allow_http_bridge: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileTypes {
    pub capture: Vec<String>,
    pub exclude_sites: Vec<String>,
    pub exclude_urls: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    pub categories: Vec<Category>,
    pub set_file_date: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub exts: Vec<String>,
    pub remember_last: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Downloads {
    pub show_file_info: bool,
    pub show_progress: bool,
    pub show_complete: bool,
    pub duplicate: String,
    pub user_agent: String,
    pub antivirus: Antivirus,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Antivirus {
    pub enabled: bool,
    pub program: String,
    pub args: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub max_connections: u32,
    pub max_active: u32,
    pub exceptions: Vec<Exception>,
    pub quota: Quota,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Exception {
    pub host: String,
    pub max: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Quota {
    pub enabled: bool,
    pub mb: u64,
    pub hours: u64,
    pub warn: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proxy {
    pub mode: String,
    pub pac_url: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub host: String,
    pub port: u32,
    pub user: String,
    pub pass: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Site {
    pub site: String,
    pub user: String,
    pub pass: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Retry {
    pub attempts: u32,
    pub delay: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Sound {
    pub enabled: bool,
    pub file: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SpeedLimit {
    pub enabled: bool,
    pub kbps: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ui {
    pub theme: String,
    pub hide_categories: bool,
    pub toolbar: String,
    pub font_size: u32,
    pub sort_by: String,
    pub sort_dir: String,
    pub columns: IndexMap<String, bool>,
    pub column_widths: IndexMap<String, u32>,
    pub close_to_tray: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub id: String,
    pub name: String,
    pub max_concurrent: u32,
    pub schedule: Schedule,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub enabled: bool,
    pub start_mode: String,
    pub start_time: String,
    pub start_date: String,
    pub days: Vec<u8>,
    pub stop_enabled: bool,
    pub stop_time: String,
    pub after_finish: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrabberProject {
    pub id: String,
    pub name: String,
    pub url: String,
    pub depth: u32,
    pub exts: Vec<String>,
    pub same_site: bool,
}

pub fn default_queue(id: &str, name: &str) -> Queue {
    Queue {
        id: id.into(),
        name: name.into(),
        max_concurrent: 1,
        schedule: Schedule {
            enabled: false,
            start_mode: "daily".into(),
            start_time: "03:00".into(),
            start_date: String::new(),
            days: (0..7).collect(),
            stop_enabled: false,
            stop_time: "07:00".into(),
            after_finish: "none".into(),
        },
    }
}

pub fn join(base: &Path, dir: &str) -> String {
    if dir.is_empty() { base.display().to_string() } else { base.join(dir).display().to_string() }
}

pub fn defaults(base_dir: &Path) -> Settings {
    Settings {
        version: 2,
        language: "auto".into(),
        general: General {
            start_with_windows: true,
            monitor_clipboard: true,
            browsers: BROWSERS.iter().map(|b| (b.to_string(), true)).collect(),
            context_menu: true,
            bypass_key: "alt".into(),
            send_cookies: true,
            allow_http_bridge: false,
        },
        file_types: FileTypes {
            capture: words(CAPTURE_EXTS),
            exclude_sites: EXCLUDE_SITES.iter().map(|s| s.to_string()).collect(),
            exclude_urls: vec![],
        },
        save: Save {
            categories: CATEGORY_DEFAULTS
                .iter()
                .map(|(id, dir, exts)| Category { id: id.to_string(), name: String::new(), folder: join(base_dir, dir), exts: words(exts), remember_last: true })
                .collect(),
            set_file_date: false,
        },
        downloads: Downloads {
            show_file_info: true,
            show_progress: true,
            show_complete: true,
            duplicate: "ask".into(),
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36".into(),
            antivirus: Antivirus {
                enabled: false,
                program: r"C:\Program Files\Windows Defender\MpCmdRun.exe".into(),
                args: r#"-Scan -ScanType 3 -File "%f""#.into(),
            },
        },
        connection: Connection { max_connections: 8, max_active: 3, exceptions: vec![], quota: Quota { enabled: false, mb: 200, hours: 5, warn: true } },
        proxy: Proxy { mode: "none".into(), pac_url: String::new(), kind: "http".into(), host: String::new(), port: 8080, user: String::new(), pass: String::new() },
        sites: vec![],
        retry: Retry { attempts: 0, delay: 30 },
        sounds: SOUND_EVENTS.iter().map(|e| (e.to_string(), Sound { enabled: false, file: String::new() })).collect(),
        speed_limit: SpeedLimit { enabled: false, kbps: 1024 },
        ui: Ui {
            theme: "system".into(),
            hide_categories: false,
            toolbar: "large".into(),
            font_size: 13,
            sort_by: "addedAt".into(),
            sort_dir: "desc".into(),
            columns: COLUMNS.iter().map(|c| (c.to_string(), true)).collect(),
            column_widths: IndexMap::new(),
            close_to_tray: true,
        },
        queues: vec![default_queue("main", "")],
        grabber_projects: vec![],
    }
}

/// Version 1 (the first browser + local server build) used a flat file.
fn migrate(saved: Value) -> Value {
    if !saved.is_object() || saved.get("version").and_then(Value::as_u64) == Some(2) {
        return saved;
    }
    let mut out = serde_json::Map::new();
    if let Some(c) = saved.get("categories").filter(|c| c.is_array()) {
        out.insert("save".into(), serde_json::json!({ "categories": c }));
    }
    out.insert("downloads".into(), serde_json::json!({ "showFileInfo": saved.get("askWhereToSave"), "showProgress": saved.get("showDialog"), "showComplete": saved.get("showDialog") }));
    out.insert("connection".into(), serde_json::json!({ "maxActive": saved.get("maxActive"), "maxConnections": saved.get("maxConnections") }));
    Value::Object(out)
}

pub fn ext_of(filename: &str) -> String {
    let Some(dot) = filename.rfind('.') else { return String::new() };
    let ext = &filename[dot + 1..];
    if (1..=10).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric()) { ext.to_ascii_lowercase() } else { String::new() }
}

/// Picks the category for a file name, falling back to its MIME type.
pub fn categorize<'a>(s: &'a Settings, filename: &str, mime: &str) -> &'a Category {
    let ext = ext_of(filename);
    let cats = &s.save.categories;
    if !ext.is_empty() {
        if let Some(c) = cats.iter().find(|c| c.id != "general" && c.exts.contains(&ext)) {
            return c;
        }
    }
    let by_mime = if mime.starts_with("video/") { "video" } else if mime.starts_with("audio/") { "music" } else { "" };
    cats.iter().find(|c| c.id == by_mime).or_else(|| cats.iter().find(|c| c.id == "general")).unwrap_or(&cats[0])
}

/// Encrypts saved passwords ("enc:<base64>"); Windows DPAPI in the app.
pub trait Cipher: Send + Sync {
    fn encrypt(&self, text: &str) -> Result<String, String>;
    fn decrypt(&self, b64: &str) -> Result<String, String>;
}

const ENC: &str = "enc:";

fn map_secrets(v: &mut Value, f: &mut dyn FnMut(&str) -> String) {
    if let Some(p) = v.pointer_mut("/proxy/pass") {
        if let Some(s) = p.as_str() { *p = Value::String(f(s)); }
    }
    if let Some(sites) = v.get_mut("sites").and_then(Value::as_array_mut) {
        for s in sites {
            if let Some(p) = s.get_mut("pass") {
                if let Some(x) = p.as_str() { *p = Value::String(f(x)); }
            }
        }
    }
}

type Listener = Arc<dyn Fn(&Settings) + Send + Sync>;

pub struct SettingsStore {
    pub file: Option<PathBuf>,
    pub base_dir: PathBuf,
    cipher: Option<Arc<dyn Cipher>>,
    value: RwLock<Arc<Settings>>,
    listeners: Mutex<Vec<Listener>>,
}

impl SettingsStore {
    pub fn new(file: Option<PathBuf>, base_dir: PathBuf, cipher: Option<Arc<dyn Cipher>>) -> Self {
        let mut saved: Option<Value> = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok());
        let mut plaintext_on_disk = false;
        if let Some(v) = saved.as_mut() {
            map_secrets(v, &mut |s| {
                if let Some(enc) = s.strip_prefix(ENC) {
                    // Another user or machine: the password must be entered again.
                    cipher.as_ref().and_then(|c| c.decrypt(enc).ok()).unwrap_or_default()
                } else {
                    plaintext_on_disk |= !s.is_empty();
                    s.to_string()
                }
            });
        }
        let d = defaults(&base_dir);
        let value = match saved {
            Some(v) => merge(&d, &migrate(v), &base_dir).unwrap_or(d),
            None => d,
        };
        let store = SettingsStore { file, base_dir, cipher, value: RwLock::new(Arc::new(value)), listeners: Mutex::new(vec![]) };
        if plaintext_on_disk && store.cipher.is_some() {
            let _ = store.save(); // read-only folder: try again on the next change
        }
        store
    }

    pub fn get(&self) -> Arc<Settings> {
        self.value.read().unwrap().clone()
    }

    /// What goes to disk: the settings with passwords encrypted.
    pub fn serialize(&self) -> String {
        let mut v = serde_json::to_value(&*self.get()).unwrap_or(Value::Null);
        if let Some(c) = &self.cipher {
            map_secrets(&mut v, &mut |s| if s.is_empty() { String::new() } else { c.encrypt(s).map(|e| format!("{ENC}{e}")).unwrap_or_default() });
        }
        serde_json::to_string_pretty(&v).unwrap_or_default()
    }

    pub fn save(&self) -> std::io::Result<()> {
        let Some(file) = &self.file else { return Ok(()) };
        let tmp = file.with_extension(format!("json.{}.tmp", std::process::id()));
        std::fs::write(&tmp, self.serialize())?;
        std::fs::rename(tmp, file)
    }

    pub fn update(&self, patch: &Value) -> Result<Arc<Settings>, String> {
        let next = {
            let mut cur = self.value.write().unwrap();
            let next = Arc::new(merge(&cur, patch, &self.base_dir)?);
            *cur = next.clone();
            next
        };
        self.save().map_err(|e| e.to_string())?;
        let listeners = self.listeners.lock().unwrap().clone();
        for f in listeners {
            f(&next);
        }
        Ok(next)
    }

    pub fn on_change(&self, f: impl Fn(&Settings) + Send + Sync + 'static) {
        self.listeners.lock().unwrap().push(Arc::new(f));
    }

    pub fn queue(&self, id: &str) -> Option<Queue> {
        self.get().queues.iter().find(|q| q.id == id).cloned()
    }

    pub fn categorize(&self, filename: &str, mime: &str) -> Category {
        categorize(&self.get(), filename, mime).clone()
    }
}
