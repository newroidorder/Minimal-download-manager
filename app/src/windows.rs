//! Creates and tracks every window. Each page gets `window.mdm`, the same
//! bridge the Electron preload gave it, so the UI code runs unchanged.

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// window.mdm.invoke(name, ...args), window.mdm.on(event, fn), window.mdm.params
const SHIM: &str = r#"(() => {
  const params = Object.fromEntries(new URLSearchParams(location.search));
  window.mdm = {
    invoke: (name, ...args) => window.__TAURI_INTERNALS__.invoke('mdm', { name, args }),
    on: (event, fn) => {
      let off = null, dead = false;
      window.__TAURI__.event.listen('mdm:' + event, (e) => fn(e.payload)).then((u) => { if (dead) u(); else off = u; });
      return () => { dead = true; if (off) off(); };
    },
    params
  };
})();"#;

/// width, height, resizable
pub fn kind(k: &str) -> Option<(f64, f64, bool)> {
    Some(match k {
        "main" => (1180.0, 720.0, true),
        "add" => (600.0, 330.0, false),
        "download" => (600.0, 540.0, false),
        "options" => (960.0, 700.0, true),
        "scheduler" => (920.0, 720.0, true),
        "properties" => (620.0, 600.0, false),
        "batch" => (660.0, 600.0, true),
        "grabber" => (980.0, 680.0, true),
        "about" => (480.0, 460.0, false),
        "duplicate" => (600.0, 380.0, false),
        _ => return None,
    })
}

pub fn theme(setting: &str) -> Option<Theme> {
    match setting {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    }
}

pub struct Open<'a> {
    pub key: Option<String>,
    pub parent: Option<&'a WebviewWindow>,
    pub show: bool,
    pub on_top: bool,
    pub theme: Option<Theme>,
}

impl Default for Open<'_> {
    fn default() -> Self {
        Open { key: None, parent: None, show: true, on_top: false, theme: None }
    }
}

fn label_of(key: &str) -> String {
    key.chars().map(|c| if c.is_ascii_alphanumeric() || "-/:_".contains(c) { c } else { '_' }).collect()
}

pub fn create(app: &AppHandle, k: &str, params: &[(String, String)], o: Open) -> Option<WebviewWindow> {
    let (width, height, resizable) = kind(k)?;
    let label = label_of(o.key.as_deref().unwrap_or(k));
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Some(w);
    }
    let query = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params).finish();
    let path = if query.is_empty() { format!("{k}.html") } else { format!("{k}.html?{query}") };
    let main = k == "main";
    let (show, on_top) = (o.show, o.on_top);
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(path.into()))
        .title("Minimal Download Manager")
        .inner_size(width, height)
        .min_inner_size(if main { 780.0 } else { width.min(480.0) }, if main { 480.0 } else { height.min(300.0) })
        .resizable(resizable)
        .maximizable(resizable)
        .decorations(!main) // the main window draws its own title bar with the menus
        .visible(false)
        .theme(o.theme)
        .initialization_script(SHIM)
        // Pages never navigate away; links go to the default browser.
        .on_navigation(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost"))
        .on_page_load(move |w, p| {
            if p.event() != PageLoadEvent::Finished || !show || w.is_visible().unwrap_or(false) {
                return;
            }
            let _ = w.show();
            if on_top {
                // Captured from the browser: come to the front once.
                let _ = w.set_always_on_top(true);
                let _ = w.set_focus();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let _ = w.set_always_on_top(false);
                });
            }
        });
    if let Some(p) = o.parent {
        b = b.parent(p).ok()?;
    }
    b.build().ok()
}

pub fn get(app: &AppHandle, key: &str) -> Option<WebviewWindow> {
    app.get_webview_window(&label_of(key))
}

pub fn broadcast<S: Serialize + Clone>(app: &AppHandle, event: &str, data: S) {
    let _ = app.emit(&format!("mdm:{event}"), data);
}

pub fn retheme(app: &AppHandle, setting: &str) {
    for w in app.webview_windows().values() {
        let _ = w.set_theme(theme(setting));
    }
}

/// Dialogs size themselves to their content.
pub fn fit(w: &WebviewWindow, height: f64) {
    if w.is_maximized().unwrap_or(false) {
        return;
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let width = w.inner_size().map(|s| s.width as f64 / scale).unwrap_or(600.0);
    let _ = w.set_size(LogicalSize::new(width, height.clamp(160.0, 900.0).round()));
}
