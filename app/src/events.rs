//! Reacting to the engine and to settings changes: windows, sounds,
//! notifications, power actions, theme, language and proxy.

use crate::{i18n, system, tray, windows, Ctx};
use base64::Engine;
use mdm_core::manager::Event;
use mdm_core::settings::{Queue, Settings};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::mpsc::UnboundedReceiver;

pub fn wire(ctx: &Arc<Ctx>, mut rx: UnboundedReceiver<Event>) {
    let c = ctx.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(e) = rx.recv().await {
            on_event(&c, e);
        }
    });

    let last = Mutex::new(ctx.settings.get().as_ref().clone());
    let c = ctx.clone();
    ctx.settings.on_change(move |v: &Settings| {
        windows::broadcast(&c.app, "settings", v.clone());
        let mut last = last.lock().unwrap();
        if v.ui.theme != last.ui.theme {
            windows::retheme(&c.app, &v.ui.theme);
        }
        if v.language != last.language {
            *c.lang.write().unwrap() = i18n::resolve(&v.language);
            let lang = c.lang();
            windows::broadcast(&c.app, "i18n", json!({ "lang": lang, "dict": i18n::dict(&lang) }));
        }
        if v.proxy != last.proxy {
            c.apply_proxy();
        }
        if v.general.start_with_windows != last.general.start_with_windows && !cfg!(debug_assertions) {
            system::set_autostart(v.general.start_with_windows);
        }
        if v.language != last.language || v.speed_limit.enabled != last.speed_limit.enabled {
            tray::refresh_menu(&c);
        }
        *last = v.clone();
    });
}

fn on_event(ctx: &Arc<Ctx>, e: Event) {
    let s = ctx.settings.get();
    match e {
        Event::Update(item) => windows::broadcast(&ctx.app, "item", item),
        Event::Remove(id) => windows::broadcast(&ctx.app, "remove", json!({ "id": id })),
        Event::Queues(list) => windows::broadcast(&ctx.app, "queues", list),
        Event::Complete(item) => {
            play_sound(ctx, "complete", false);
            if s.downloads.show_complete {
                ctx.open_download(&item.id);
            } else {
                ctx.notify(&ctx.t("notify.completeTitle", &[]), &item.filename);
            }
        }
        Event::Failed(item) => {
            play_sound(ctx, "failed", false);
            if windows::get(&ctx.app, &format!("dl:{}", item.id)).is_none() {
                ctx.notify(&ctx.t("notify.failedTitle", &[]), &format!("{}: {}", item.filename, item.error.unwrap_or_default()));
            }
        }
        Event::QueueStart(_) => play_sound(ctx, "queueStart", false),
        Event::QueueEnd(q, after) => {
            play_sound(ctx, "queueEnd", false);
            after_queue(ctx, &after, &queue_name(ctx, q.as_ref()));
        }
        Event::Quota { until } => {
            let time = chrono::DateTime::from_timestamp_millis(until).map(|t| t.with_timezone(&chrono::Local).format("%H:%M:%S").to_string()).unwrap_or_default();
            ctx.notify(&ctx.t("notify.quotaTitle", &[]), &ctx.t("notify.quota", &[("time", &time)]));
        }
        Event::QuotaWarning { mb, hours } => {
            ctx.notify(&ctx.t("notify.quotaTitle", &[]), &ctx.t("notify.quotaWarning", &[("mb", &mb.to_string()), ("hours", &hours.to_string())]));
        }
    }
}

fn queue_name(ctx: &Ctx, q: Option<&Queue>) -> String {
    match q {
        Some(q) if q.id == "main" && q.name.is_empty() => ctx.t("queue.main", &[]),
        Some(q) => q.name.clone(),
        None => String::new(),
    }
}

fn after_queue(ctx: &Arc<Ctx>, action: &str, name: &str) {
    let title = ctx.t("notify.queueEndTitle", &[]);
    match action {
        "exit" => {
            ctx.notify(&title, &ctx.t("notify.queueEndExit", &[("name", name)]));
            let c = ctx.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                c.quit();
            });
        }
        "shutdown" => {
            system::shutdown(&ctx.t("notify.shutdownMessage", &[("name", name)]));
            ctx.app
                .dialog()
                .message(ctx.t("notify.shutdownDetail", &[("name", name)]))
                .title(ctx.t("notify.shutdownTitle", &[]))
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(ctx.t("notify.cancelShutdown", &[]), ctx.t("common.ok", &[])))
                .show(|cancel| {
                    if cancel {
                        system::cancel_shutdown();
                    }
                });
        }
        "sleep" => {
            ctx.notify(&title, &ctx.t("notify.queueEndSleep", &[("name", name)]));
            tauri::async_runtime::spawn(async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                system::sleep();
            });
        }
        _ => ctx.notify(&title, &ctx.t("notify.queueEnd", &[("name", name)])),
    }
}

/// Sounds play in the main window (it exists even when hidden in the tray).
pub fn play_sound(ctx: &Ctx, event: &str, force: bool) {
    let s = ctx.settings.get();
    let Some(snd) = s.sounds.get(event) else { return };
    if !snd.enabled && !force {
        return;
    }
    let mut payload = json!({ "beep": event });
    if !snd.file.is_empty() {
        let p = std::path::Path::new(&snd.file);
        // A missing or huge file falls back to the built-in sound.
        if let Some(data) = std::fs::metadata(p).ok().filter(|m| m.len() < 10 * 1024 * 1024).and_then(|_| std::fs::read(p).ok()) {
            {
                let mime = match p.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
                    Some("mp3") => "audio/mpeg",
                    Some("ogg") => "audio/ogg",
                    Some("m4a") => "audio/mp4",
                    _ => "audio/wav",
                };
                payload = json!({ "data": base64::engine::general_purpose::STANDARD.encode(data), "mime": mime });
            }
        }
    }
    let _ = ctx.app.emit_to("main", "mdm:sound", payload);
}

/// The old 127.0.0.1 connection follows Options > General.
pub fn sync_http(ctx: &Arc<Ctx>, port: u16) {
    let want = ctx.settings.get().general.allow_http_bridge;
    let Some(bridge) = ctx.bridge.get().cloned() else { return };
    {
        let mut st = ctx.bridge_state.lock().unwrap();
        if st["http"]["enabled"].as_bool() == Some(want) {
            return;
        }
        st["http"]["enabled"] = json!(want);
    }
    if !want {
        bridge.stop_http();
        ctx.bridge_state.lock().unwrap()["http"] = json!({ "enabled": false, "listening": false, "port": 0, "error": null });
        ctx.broadcast_bridge();
        return;
    }
    let c = ctx.clone();
    tauri::async_runtime::spawn(async move {
        let mut warned = false;
        while c.bridge_state.lock().unwrap()["http"]["enabled"] == json!(true) {
            match bridge.listen_http(port) {
                Ok(p) => {
                    c.bridge_state.lock().unwrap()["http"] = json!({ "enabled": true, "listening": true, "port": p, "error": null });
                    c.broadcast_bridge();
                    return;
                }
                Err(e) => {
                    let in_use = e.contains("10048") || e.to_lowercase().contains("in use");
                    c.bridge_state.lock().unwrap()["http"] = json!({ "enabled": true, "listening": false, "port": port, "error": if in_use { "in-use".to_string() } else { e } });
                    c.broadcast_bridge();
                    if in_use && !warned {
                        warned = true;
                        c.notify(&c.t("notify.portBusyTitle", &[]), &c.t("notify.portBusy", &[("port", &port.to_string())]));
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}
