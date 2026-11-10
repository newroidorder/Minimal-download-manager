//! The notification-area icon and its menu.

use crate::{windows, Ctx};
use serde_json::json;
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, Wry};

fn menu(ctx: &Ctx) -> tauri::Result<Menu<Wry>> {
    let app = &ctx.app;
    let item = |id: &str, key: &str| MenuItem::with_id(app, id, ctx.t(key, &[]), true, None::<&str>);
    let limit = CheckMenuItem::with_id(app, "limit", ctx.t("menu.speedLimiter", &[]), true, ctx.settings.get().speed_limit.enabled, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &item("open", "tray.open")?,
            &item("add", "menu.addUrl")?,
            &PredefinedMenuItem::separator(app)?,
            &limit,
            &item("startq", "menu.startQueue")?,
            &item("stopq", "menu.stopQueue")?,
            &PredefinedMenuItem::separator(app)?,
            &item("exit", "menu.exit")?,
        ],
    )
}

pub fn create(ctx: &Arc<Ctx>) -> tauri::Result<()> {
    let icon = ctx.app.path().resource_dir().ok().and_then(|d| Image::from_path(d.join("tray.png")).ok()).or_else(|| ctx.app.default_window_icon().cloned());
    let mut b = TrayIconBuilder::with_id("main")
        .tooltip("Minimal Download Manager")
        .menu(&menu(ctx)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| {
            let ctx = app.state::<Arc<Ctx>>().inner().clone();
            let id = e.id().as_ref().to_string();
            // Windows are built off the event loop thread.
            tauri::async_runtime::spawn(async move {
                match id.as_str() {
                    "open" => ctx.show_main(),
                    "add" => {
                        windows::create(&ctx.app, "add", &[], windows::Open { on_top: true, theme: ctx.theme(), ..Default::default() });
                    }
                    "limit" => {
                        let on = !ctx.settings.get().speed_limit.enabled;
                        let _ = ctx.settings.update(&json!({ "speedLimit": { "enabled": on } }));
                    }
                    "startq" => {
                        ctx.manager.start_queue("main");
                    }
                    "stopq" => {
                        ctx.manager.stop_queue("main");
                    }
                    "exit" => ctx.quit(),
                    _ => {}
                }
            });
        })
        .on_tray_icon_event(|tray, e| {
            if matches!(e, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } | TrayIconEvent::DoubleClick { .. }) {
                let ctx = tray.app_handle().state::<Arc<Ctx>>().inner().clone();
                tauri::async_runtime::spawn(async move { ctx.show_main() });
            }
        });
    if let Some(i) = icon {
        b = b.icon(i);
    }
    b.build(&ctx.app)?;
    Ok(())
}

pub fn refresh_menu(ctx: &Ctx) {
    if let (Some(t), Ok(m)) = (ctx.app.tray_by_id("main"), menu(ctx)) {
        let _ = t.set_menu(Some(m));
    }
}

pub fn update_tooltip(ctx: &Ctx) {
    let Some(t) = ctx.app.tray_by_id("main") else { return };
    let active: Vec<_> = ctx.manager.list().into_iter().filter(|i| i.status == "downloading").collect();
    let speed: u64 = active.iter().map(|i| i.speed).sum();
    let fmt = if speed > 1_048_576 { format!("{:.1} MB/s", speed as f64 / 1_048_576.0) } else { format!("{} KB/s", (speed as f64 / 1024.0).round()) };
    let text = if active.is_empty() {
        "Minimal Download Manager".to_string()
    } else {
        format!("Minimal Download Manager: {} · {fmt}", ctx.t("tray.active", &[("n", &active.len().to_string())]))
    };
    let _ = t.set_tooltip(Some(text));
}
