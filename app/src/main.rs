//! Minimal Download Manager: the Windows program. It owns the download engine,
//! the windows, the tray icon, and the bridge the browser extension talks to.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cipher;
mod events;
mod i18n;
mod ipc;
mod native;
mod system;
mod tray;
mod windows;

use mdm_core::bridge::{Bridge, Hooks};
use mdm_core::config::{load_config, EXTENSION_ID};
use mdm_core::http::{build_client, ProxyResolver};
use mdm_core::manager::{is_busy, AddOpts, AddResult, Item, Manager, ManagerConfig};
use mdm_core::scheduler::Scheduler;
use mdm_core::settings::SettingsStore;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use tauri::{AppHandle, Manager as _, RunEvent, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tokio_util::sync::CancellationToken;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct Ctx {
    pub app: AppHandle,
    pub home: PathBuf,
    pub settings: Arc<SettingsStore>,
    pub manager: Manager,
    pub bridge: OnceLock<Arc<Bridge>>,
    /// listening: the private pipe. http: the optional 127.0.0.1 connection. live: browsers connected now.
    pub bridge_state: Mutex<Value>,
    pub lang: RwLock<String>,
    pub pending_duplicates: Mutex<HashMap<String, (AddOpts, Item)>>,
    pub grabs: Mutex<HashMap<String, CancellationToken>>,
    pub quitting: AtomicBool,
    tray_hint: AtomicBool,
    scheduler: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Ctx {
    pub fn t(&self, key: &str, vars: &[(&str, &str)]) -> String {
        i18n::t(&self.lang.read().unwrap(), key, vars)
    }

    pub fn lang(&self) -> String {
        self.lang.read().unwrap().clone()
    }

    pub fn theme(&self) -> Option<tauri::Theme> {
        windows::theme(&self.settings.get().ui.theme)
    }

    pub fn notify(&self, title: &str, body: &str) {
        let _ = self.app.notification().builder().title(title).body(body).show();
    }

    pub fn open_download(&self, id: &str) {
        let o = windows::Open { key: Some(format!("dl:{id}")), on_top: true, theme: self.theme(), ..Default::default() };
        windows::create(&self.app, "download", &[("id".into(), id.into())], o);
    }

    pub fn show_main(&self) {
        let w = windows::get(&self.app, "main").or_else(|| windows::create(&self.app, "main", &[], windows::Open { theme: self.theme(), ..Default::default() }));
        if let Some(w) = w {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    pub fn broadcast_bridge(&self) {
        let s = self.bridge_state.lock().unwrap().clone();
        windows::broadcast(&self.app, "bridge", s);
    }

    /// Opens the windows that follow adding a download.
    pub fn handle_result(&self, result: AddResult, request: AddOpts) {
        let s = self.settings.get();
        if let Some(existing) = result.duplicate {
            let token = uuid::Uuid::new_v4().to_string();
            self.pending_duplicates.lock().unwrap().insert(token.clone(), (request, existing));
            let o = windows::Open { key: Some(format!("dup:{token}")), on_top: true, theme: self.theme(), ..Default::default() };
            windows::create(&self.app, "duplicate", &[("token".into(), token)], o);
            return;
        }
        let Some(item) = result.item else { return };
        if result.existing {
            if if item.status == "done" { s.downloads.show_complete } else { s.downloads.show_progress } {
                self.open_download(&item.id);
            }
            return;
        }
        if item.status == "pending" || (s.downloads.show_progress && item.queue_id.is_none()) {
            self.open_download(&item.id);
        }
    }

    pub fn handle_args(&self, argv: &[String]) {
        let Some(link) = argv.iter().find(|a| a.to_ascii_lowercase().starts_with("minimaldm://")) else { return };
        let target = url::Url::parse(link).ok().filter(|u| u.host_str() == Some("add")).and_then(|u| u.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned()));
        match target {
            Some(url) => {
                let req = AddOpts { url, interactive: true, kind: Some("manual".into()), ..Default::default() };
                if let Ok(r) = self.manager.add(req.clone()) {
                    self.handle_result(r, req);
                }
            }
            None => self.show_main(),
        }
    }

    pub fn apply_proxy(&self) {
        let p = self.settings.get().proxy.clone();
        self.manager.set_client(build_client(&p, Some(resolver(&self.settings))));
    }

    pub fn quit(self: &Arc<Self>) {
        if self.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        let ctx = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(t) = ctx.scheduler.lock().unwrap().take() {
                t.abort();
            }
            if let Some(b) = ctx.bridge.get() {
                b.close();
            }
            ctx.manager.close().await;
            ctx.app.exit(0);
        });
    }

    pub fn extension_dir(&self) -> PathBuf {
        resource(&self.app, "extension")
    }
}

/// A bundled file, without the "\\?\" prefix Tauri adds (browsers and people read these paths).
fn resource(app: &AppHandle, name: &str) -> PathBuf {
    let p = app.path().resource_dir().map(|d| d.join(name)).unwrap_or_default();
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(s) if !s.starts_with("UNC\\") => PathBuf::from(s),
        _ => p,
    }
}

fn resolver(settings: &Arc<SettingsStore>) -> ProxyResolver {
    system::proxy_resolver(settings.clone())
}

fn home_dir() -> PathBuf {
    std::env::var_os("MDM_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("Minimal Download Manager"))
}

fn host_exe(app: &AppHandle) -> PathBuf {
    let bundled = Some(resource(app, "mdm-host.exe")).filter(|p| p.exists());
    bundled.unwrap_or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("mdm-host.exe"))).unwrap_or_default())
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let home = home_dir();
    std::fs::create_dir_all(&home)?;
    let base = std::env::var_os("MDM_SAVE_DIR").map(PathBuf::from).or_else(|| app.path().download_dir().ok()).unwrap_or_else(|| home.join("Downloads"));
    let cipher: Arc<dyn mdm_core::settings::Cipher> = Arc::new(cipher::Dpapi::new(&home));
    let settings = Arc::new(SettingsStore::new(Some(home.join("settings.json")), base, Some(cipher)));
    let rt = tauri::async_runtime::block_on(async { tokio::runtime::Handle::current() });
    let run_program: mdm_core::manager::RunProgram = Arc::new(|p, a, f| Box::pin(system::run_program(p, a, f)));
    let (manager, rx) = Manager::new(ManagerConfig {
        client: build_client(&settings.get().proxy, Some(resolver(&settings))),
        settings: settings.clone(),
        state_file: Some(home.join("downloads.json")),
        run_program: Some(run_program),
        tweak: None,
        rt: rt.clone(),
    });
    let ctx = Arc::new(Ctx {
        app: handle.clone(),
        home: home.clone(),
        settings: settings.clone(),
        manager: manager.clone(),
        bridge: OnceLock::new(),
        bridge_state: Mutex::new(json!({ "listening": false, "error": null, "http": { "enabled": false, "listening": false, "port": 0, "error": null }, "seen": {}, "live": {} })),
        lang: RwLock::new(i18n::resolve(&settings.get().language)),
        pending_duplicates: Mutex::new(HashMap::new()),
        grabs: Mutex::new(HashMap::new()),
        quitting: AtomicBool::new(false),
        tray_hint: AtomicBool::new(false),
        scheduler: Mutex::new(None),
    });
    app.manage(ctx.clone());

    events::wire(&ctx, rx);
    *ctx.scheduler.lock().unwrap() = Some(Arc::new(Scheduler::new(manager.clone())).start(&rt));
    tray::create(&ctx)?;
    let hidden = std::env::args().any(|a| a == "--hidden");
    windows::create(&handle, "main", &[], windows::Open { show: !hidden, theme: ctx.theme(), ..Default::default() });

    start_bridge(&ctx, &rt)?;

    let (c1, c2) = (ctx.clone(), ctx.clone());
    system::watch_clipboard(
        move || c1.settings.get().general.monitor_clipboard,
        move |url| {
            let s = c2.settings.get();
            if mdm_core::rules::capture_decision(&s, &url, None, None, None, "click").capture && c2.manager.find_duplicate(&url).is_none() {
                let req = AddOpts { url, interactive: true, kind: Some("clipboard".into()), ..Default::default() };
                if let Ok(r) = c2.manager.add(req.clone()) {
                    c2.handle_result(r, req);
                }
            }
        },
    );
    let c3 = ctx.clone();
    system::keep_awake(move || {
        tray::update_tooltip(&c3);
        c3.manager.list().iter().any(|i| is_busy(&i.status))
    });
    if !cfg!(debug_assertions) {
        // never register a development build
        system::set_autostart(settings.get().general.start_with_windows);
        system::register_link_type();
    }
    ctx.handle_args(&std::env::args().collect::<Vec<_>>());
    Ok(())
}

/// The browser connection: native messaging over a private pipe, plus the old
/// 127.0.0.1 HTTP connection only when switched on in Options > General.
fn start_bridge(ctx: &Arc<Ctx>, rt: &tokio::runtime::Handle) -> std::io::Result<()> {
    let config = load_config(&ctx.home)?;
    let (a, b, c) = (ctx.clone(), ctx.clone(), ctx.clone());
    let hooks = Hooks {
        on_capture: Box::new(move |r, req| a.handle_result(r, req)),
        on_seen: Box::new(move |browser| {
            let now = mdm_core::now_ms();
            let fresh = {
                let mut st = b.bridge_state.lock().unwrap();
                let last = st["seen"][browser].as_i64().unwrap_or(0);
                st["seen"][browser] = json!(now);
                now - last > 60_000
            };
            if fresh {
                b.broadcast_bridge(); // show "Connected" right away
            }
        }),
        on_connections: Box::new(move |live| {
            c.bridge_state.lock().unwrap()["live"] = json!(live);
            c.broadcast_bridge();
        }),
    };
    let bridge = Bridge::new(ctx.manager.clone(), config.token, &[EXTENSION_ID], VERSION, hooks);
    let _ = ctx.bridge.set(bridge.clone());
    let pipe = mdm_core::protocol::pipe_path(&ctx.home);
    match bridge.listen_pipe(&pipe, rt) {
        Ok(()) => ctx.bridge_state.lock().unwrap()["listening"] = json!(true),
        Err(e) => ctx.bridge_state.lock().unwrap()["error"] = json!(e.to_string()),
    }
    let extra: Vec<PathBuf> = std::env::var("MDM_NATIVE_DIRS").map(|v| std::env::split_paths(&v).collect()).unwrap_or_default();
    if let Err(e) = native::install(&ctx.home, &host_exe(&ctx.app), EXTENSION_ID, &extra) {
        ctx.bridge_state.lock().unwrap()["error"] = json!(format!("native host: {e}"));
    }
    let port = config.port;
    let c = ctx.clone();
    ctx.settings.on_change(move |_| events::sync_http(&c, port));
    events::sync_http(ctx, port);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(ctx) = app.try_state::<Arc<Ctx>>() {
                ctx.handle_args(&argv);
                ctx.show_main();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![ipc::mdm])
        .setup(|app| {
            setup(app).map_err(|e| {
                tauri_plugin_dialog::DialogExt::dialog(app.handle()).message(format!("Minimal Download Manager could not start:\n\n{e}")).blocking_show();
                e
            })
        })
        .on_window_event(|w, e| {
            if w.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = e {
                let ctx = w.state::<Arc<Ctx>>();
                api.prevent_close();
                if !ctx.settings.get().ui.close_to_tray {
                    ctx.quit();
                    return;
                }
                let _ = w.hide();
                if !ctx.tray_hint.swap(true, Ordering::SeqCst) {
                    ctx.notify("Minimal Download Manager", &ctx.t("notify.inTray", &[]));
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|_app, e| {
            // Closing the last window keeps the program running in the tray.
            if let RunEvent::ExitRequested { api, code: None, .. } = e {
                api.prevent_exit();
            }
        });
}
