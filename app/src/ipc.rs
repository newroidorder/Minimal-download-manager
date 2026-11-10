//! Everything a window can ask the program to do: mdm.invoke(name, ...args).

use crate::{events, i18n, system, windows, Ctx, VERSION};
use mdm_core::config::EXTENSION_ID;
use mdm_core::grabber::{grab, GrabOpts};
use mdm_core::http::fetch_page;
use mdm_core::manager::AddOpts;
use mdm_core::rules::{basic, credentials_for};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

const REPO: &str = "newroidorder/minimal-download-manager";

fn link(which: &str) -> Option<String> {
    Some(match which {
        "home" => format!("https://github.com/{REPO}"),
        "help" => format!("https://github.com/{REPO}#readme"),
        "issues" => format!("https://github.com/{REPO}/issues"),
        "releases" => format!("https://github.com/{REPO}/releases"),
        _ => return None,
    })
}

fn existing_ancestor(dir: &str) -> Option<PathBuf> {
    let mut d = Some(PathBuf::from(dir)).filter(|_| !dir.is_empty())?;
    loop {
        if d.exists() {
            return Some(d);
        }
        d = d.parent()?.to_path_buf();
    }
}

pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |s: &str| -> Vec<u64> { s.trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    let (pa, pb) = (parts(a), parts(b));
    (0..3).map(|i| pa.get(i).unwrap_or(&0).cmp(pb.get(i).unwrap_or(&0))).find(|o| o.is_ne()).unwrap_or(std::cmp::Ordering::Equal)
}

fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

fn ids(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn add_many(ctx: &Ctx, urls: &[Value], o: &Value) -> usize {
    let mut n = 0;
    for url in urls.iter().take(10_000).filter_map(Value::as_str) {
        let req = AddOpts {
            url: url.to_string(),
            kind: Some("manual".into()),
            start: Some(o["start"] != json!(false)),
            queue_id: o["queueId"].as_str().map(String::from),
            duplicate: Some("number".into()),
            dir: o["dir"].as_str().filter(|d| !d.is_empty()).map(String::from),
            ..Default::default()
        };
        if ctx.manager.add(req).is_ok_and(|r| r.item.is_some()) {
            n += 1; // bad lines are skipped
        }
    }
    n
}

fn to_value<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn mdm(window: WebviewWindow, ctx: State<'_, Arc<Ctx>>, name: String, args: Vec<Value>) -> Result<Value, String> {
    let ctx: Arc<Ctx> = ctx.inner().clone();
    let m = &ctx.manager;
    let a0 = arg(&args, 0);
    let a1 = arg(&args, 1);
    Ok(match name.as_str() {
        "state" => {
            let lang = ctx.lang();
            json!({
                "items": m.list(), "settings": ctx.settings.get().as_ref(), "queues": m.running_queues(),
                "lang": lang, "dict": i18n::dict(&lang), "version": VERSION,
                "bridge": ctx.bridge_state.lock().unwrap().clone(), "extensionId": EXTENSION_ID,
                "platform": "win32", "defaultsBase": ctx.settings.base_dir,
            })
        }
        "item" => to_value(m.get(text(a0))),
        "bridge" => ctx.bridge_state.lock().unwrap().clone(),
        "clipboardUrl" => {
            let v = system::clipboard_text().trim().to_string();
            json!(if system::is_link(&v) { v } else { String::new() })
        }

        // Add URL window and other manual adds.
        "add" => {
            let mut headers = vec![];
            if let Some(u) = a0["user"].as_str().filter(|u| !u.is_empty()) {
                headers.push(("Authorization".to_string(), basic(u, a0["pass"].as_str().unwrap_or(""))));
            }
            let req = AddOpts {
                url: text(&a0["url"]).trim().to_string(),
                filename: a0["filename"].as_str().filter(|f| !f.is_empty()).map(String::from),
                description: a0["description"].as_str().map(String::from),
                headers,
                interactive: a0["interactive"] != json!(false),
                kind: Some("manual".into()),
                start: Some(a0["start"] != json!(false)),
                queue_id: a0["queueId"].as_str().map(String::from),
                ..Default::default()
            };
            let r = m.add(req.clone())?;
            let out = json!({ "id": r.item.as_ref().map(|i| i.id.clone()), "duplicate": r.duplicate.is_some() });
            ctx.handle_result(r, req);
            out
        }
        // Batch, grabber and import: many links at once, no dialogs.
        "addMany" => json!(add_many(&ctx, a0.as_array().map(Vec::as_slice).unwrap_or(&[]), a1)),
        "confirm" => to_value(m.confirm(text(a0), a1)?),
        "pause" => { ids(a0).iter().for_each(|id| { m.pause(id); }); Value::Null }
        "resume" => { ids(a0).iter().for_each(|id| { m.resume(id); }); Value::Null }
        "cancel" => { for id in ids(a0) { m.cancel(&id).await; } Value::Null }
        "redownload" => { for id in ids(a0) { m.redownload(&id).await; } Value::Null }
        "remove" => { let del = a1["deleteFile"] == json!(true); for id in ids(a0) { m.remove(&id, del).await; } Value::Null }
        "removeCompleted" => json!(m.remove_completed()),
        "pauseAll" => { m.list().iter().filter(|i| mdm_core::manager::is_active(&i.status)).for_each(|i| { m.pause(&i.id); }); Value::Null }
        "stopAll" => { m.stop_all(); Value::Null }
        "edit" => to_value(m.edit(text(a0), a1["description"].as_str(), a1["url"].as_str())?),
        "open" => match m.get(text(a0)).and_then(|i| i.dest.filter(|d| i.status == "done" && Path::new(d).exists())) {
            Some(d) => { ctx.app.opener().open_path(d, None::<&str>).map_err(|e| e.to_string())?; Value::Null }
            None => json!("missing"),
        },
        "openFolder" => {
            let i = m.get(text(a0));
            match (i.as_ref().and_then(|i| i.dest.clone()), i.as_ref().and_then(|i| i.dir.clone())) {
                (Some(d), _) if Path::new(&d).exists() => { let _ = ctx.app.opener().reveal_item_in_dir(d); json!("ok") }
                (_, Some(d)) if Path::new(&d).exists() => { let _ = ctx.app.opener().open_path(d, None::<&str>); json!("ok") }
                _ => json!("missing"),
            }
        }
        "showDownload" => { ctx.open_download(text(a0)); Value::Null }

        "setQueue" => { m.set_queue(&ids(a0), a1.as_str().filter(|q| !q.is_empty()))?; Value::Null }
        "reorderQueue" => { m.reorder_queue(text(a0), &ids(a1)); Value::Null }
        "startQueue" => json!(m.start_queue(text(a0))),
        "stopQueue" => json!(m.stop_queue(text(a0))),
        "deleteQueue" => { m.delete_queue(text(a0))?; Value::Null }

        "settings" => to_value(ctx.settings.update(a0)?.as_ref()),
        "resetSection" => {
            let d = mdm_core::settings::defaults(&ctx.settings.base_dir);
            let patch = match text(a0) {
                "fileTypes.capture" => json!({ "fileTypes": { "capture": d.file_types.capture } }),
                "fileTypes.excludeSites" => json!({ "fileTypes": { "excludeSites": d.file_types.exclude_sites } }),
                _ => json!({}),
            };
            to_value(ctx.settings.update(&patch)?.as_ref())
        }
        "pickFolder" => {
            let mut d = ctx.app.dialog().file().set_parent(&window);
            if let Some(start) = existing_ancestor(text(a0)) {
                d = d.set_directory(start);
            }
            to_value(d.blocking_pick_folder().and_then(|p| p.into_path().ok()))
        }
        "pickFile" => {
            let d = ctx.app.dialog().file().set_parent(&window);
            let d = match text(a0) {
                "sound" => d.add_filter("Audio", &["wav", "mp3", "ogg", "m4a"]),
                "program" => d.add_filter("Programs", &["exe", "bat", "cmd", "com"]).add_filter("*", &["*"]),
                _ => d.add_filter("Text", &["txt"]).add_filter("*", &["*"]),
            };
            to_value(d.blocking_pick_file().and_then(|p| p.into_path().ok()))
        }
        "testSound" => { events::play_sound(&ctx, text(a0), true); Value::Null }

        "exportList" => {
            let Some(path) = ctx.app.dialog().file().set_parent(&window).set_file_name("download-list.txt").add_filter("Text", &["txt"]).blocking_save_file().and_then(|p| p.into_path().ok()) else { return Ok(json!(0)) };
            let urls: Vec<String> = m.list().into_iter().map(|i| i.url).collect();
            std::fs::write(path, urls.join("\r\n") + "\r\n").map_err(|e| e.to_string())?;
            json!(urls.len())
        }
        "importList" => {
            let Some(path) = ctx.app.dialog().file().set_parent(&window).add_filter("Text", &["txt"]).add_filter("*", &["*"]).blocking_pick_file().and_then(|p| p.into_path().ok()) else { return Ok(json!(0)) };
            let body = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            let urls: Vec<Value> = body.lines().map(str::trim).filter(|l| l.to_ascii_lowercase().starts_with("http://") || l.to_ascii_lowercase().starts_with("https://")).map(|l| json!(l)).collect();
            json!(add_many(&ctx, &urls, &json!({ "start": false, "queueId": "main" })))
        }

        "batchExpand" => {
            let width = arg(&args, 3).as_u64().or_else(|| arg(&args, 3).as_str().and_then(|s| s.parse().ok())).unwrap_or(0) as usize;
            let s = |v: &Value| v.as_str().map(String::from).unwrap_or_else(|| v.to_string());
            json!(mdm_core::batch::expand(text(a0), &s(a1), &s(arg(&args, 2)), width)?)
        }

        "grab" => {
            let label = window.label().to_string();
            if let Some(t) = ctx.grabs.lock().unwrap().remove(&label) {
                t.cancel();
            }
            let cancel = CancellationToken::new();
            ctx.grabs.lock().unwrap().insert(label.clone(), cancel.clone());
            let s = ctx.settings.get();
            let client = m.client();
            let (ua, sites) = (s.downloads.user_agent.clone(), s.sites.clone());
            let fetch = |u: String| {
                let mut headers = vec![("User-Agent".to_string(), ua.clone())];
                if let Some(auth) = credentials_for(&sites, &u) {
                    headers.push(("Authorization".into(), auth));
                }
                let (client, cancel) = (client.clone(), cancel.clone());
                async move { fetch_page(&client, &u, &headers, &cancel).await }
            };
            let w = window.clone();
            let on_page = move |url: &str, found: usize| {
                let _ = w.emit_to(w.label(), "mdm:grab", json!({ "url": url, "found": found }));
            };
            let exts: Vec<String> = a0["exts"].as_array().map(|a| a.iter().filter_map(|e| e.as_str().map(String::from)).collect()).unwrap_or_default();
            let o = GrabOpts {
                depth: a0["depth"].as_u64().unwrap_or(1).min(3) as u32,
                exts,
                same_site: a0["sameSite"] != json!(false),
                max_pages: 200,
                cancel: cancel.clone(),
                on_page: &on_page,
            };
            let r = grab(text(&a0["url"]), fetch, o).await;
            ctx.grabs.lock().unwrap().remove(&label);
            to_value(r?)
        }
        "grabStop" => {
            if let Some(t) = ctx.grabs.lock().unwrap().remove(window.label()) {
                t.cancel();
            }
            Value::Null
        }

        "duplicate" => {
            let pending = ctx.pending_duplicates.lock().unwrap().remove(text(a0));
            let action = text(a1).to_string();
            if let Some((req, _)) = pending.filter(|_| action != "cancel") {
                if arg(&args, 2) == &json!(true) {
                    ctx.settings.update(&json!({ "downloads": { "duplicate": action } }))?;
                }
                let req = AddOpts { duplicate: Some(action), ..req };
                let r = m.add(req.clone())?;
                ctx.handle_result(r, req);
            }
            Value::Null
        }
        "duplicateInfo" => match ctx.pending_duplicates.lock().unwrap().get(text(a0)) {
            Some((req, existing)) => json!({ "request": req, "existing": existing }),
            None => Value::Null,
        },

        "window" => {
            let kind = text(a0);
            if windows::kind(kind).is_none() || kind == "main" {
                return Ok(Value::Null);
            }
            let params: Vec<(String, String)> = a1.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect()).unwrap_or_default();
            let key = a1["id"].as_str().map_or(kind.to_string(), |id| format!("{kind}:{id}"));
            let modal = kind == "options" || kind == "about";
            windows::create(&ctx.app, kind, &params, windows::Open { key: Some(key), parent: modal.then_some(&window), theme: ctx.theme(), ..Default::default() });
            Value::Null
        }
        "close" => { let _ = window.close(); Value::Null }
        "fit" => { windows::fit(&window, a0.as_f64().unwrap_or(0.0)); Value::Null }
        "minimize" => { let _ = window.minimize(); Value::Null }
        "maximize" => {
            let _ = if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() };
            Value::Null
        }
        "quit" => { ctx.quit(); Value::Null }
        "external" => {
            if let Some(u) = link(text(a0)) {
                let _ = ctx.app.opener().open_url(u, None::<&str>);
            }
            Value::Null
        }
        "extensionFolder" => { let _ = ctx.app.opener().open_path(ctx.extension_dir().display().to_string(), None::<&str>); Value::Null }
        "extensionPath" => json!(ctx.extension_dir()),
        "copyText" => { system::set_clipboard(&text(a0).chars().take(10_000).collect::<String>()); Value::Null }
        "proxyTest" => { ctx.apply_proxy(); Value::Null }

        "checkUpdates" => {
            let r = m.client().get(format!("https://api.github.com/repos/{REPO}/releases/latest")).header("Accept", "application/vnd.github+json").header("User-Agent", "Minimal-Download-Manager").send().await;
            let rel: Option<Value> = match r {
                Ok(r) if r.status().is_success() => r.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok()),
                _ => None,
            };
            match rel.as_ref().and_then(|v| v["tag_name"].as_str()) {
                Some(tag) => json!({ "status": if compare_versions(tag, VERSION).is_gt() { "newer" } else { "current" }, "latest": tag.trim_start_matches('v') }),
                None => json!({ "status": "unknown" }),
            }
        }
        _ => return Err(format!("unknown action {name}")),
    })
}

#[cfg(test)]
mod tests {
    use super::compare_versions;
    use std::cmp::Ordering::*;

    #[test]
    fn versions() {
        assert_eq!(compare_versions("v3.0.1", "3.0.0"), Greater);
        assert_eq!(compare_versions("2.2.2", "3.0.0"), Less);
        assert_eq!(compare_versions("3.0", "3.0.0"), Equal);
    }
}
