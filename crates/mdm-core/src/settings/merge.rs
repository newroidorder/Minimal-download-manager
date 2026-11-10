//! Merges a (partial) patch from the UI or from disk onto the current settings,
//! validating every value. Same rules as the original settings.js.

use super::*;
use crate::base36_now;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

/// JavaScript parseInt: a number, or a string that starts with digits.
fn parse_int(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i64),
        Value::String(s) => {
            let t = s.trim_start();
            let (sign, rest) = match t.strip_prefix('-') { Some(r) => (-1, r), None => (1, t.strip_prefix('+').unwrap_or(t)) };
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<i64>().ok().map(|n| n * sign)
        }
        _ => None,
    }
}

fn clamp_int<T: TryFrom<i64> + Copy>(v: Option<&Value>, min: i64, max: i64, fallback: T) -> T {
    match v.filter(|v| !v.is_null()).and_then(parse_int) {
        Some(n) => T::try_from(n.clamp(min, max)).unwrap_or(fallback),
        None => fallback,
    }
}

fn str_(v: Option<&Value>, fallback: &str, max: usize) -> String {
    match v.and_then(Value::as_str) {
        Some(s) => s.chars().take(max).collect(),
        None => fallback.to_string(),
    }
}

fn bool_(v: Option<&Value>, fallback: bool) -> bool {
    v.and_then(Value::as_bool).unwrap_or(fallback)
}

fn one_of(v: Option<&Value>, list: &[&str], fallback: &str) -> String {
    match v.and_then(Value::as_str) {
        Some(s) if list.contains(&s) => s.to_string(),
        _ => fallback.to_string(),
    }
}

static TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([01]\d|2[0-3]):[0-5]\d$").unwrap());
static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w-]{1,40}$").unwrap());
static SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s,;]+").unwrap());

fn time(v: Option<&Value>, fallback: &str) -> String {
    match v.and_then(Value::as_str) {
        Some(s) if TIME.is_match(s) => s.to_string(),
        _ => fallback.to_string(),
    }
}

pub fn is_abs(p: &str) -> bool {
    let b = p.as_bytes();
    std::path::Path::new(p).is_absolute()
        || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || (p.starts_with(r"\\") && p[2..].find('\\').is_some_and(|i| i > 0))
}

fn list_of(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().map(|x| match x { Value::String(s) => s.clone(), other => other.to_string() }).collect(),
        Value::String(s) => SPLIT.split(s).map(String::from).collect(),
        _ => vec![],
    }
}

pub fn clean_exts(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for e in list_of(v) {
        let x = e.trim().to_lowercase();
        let x = x.strip_prefix("*.").or_else(|| x.strip_prefix('.')).unwrap_or(&x).to_string();
        if (1..=10).contains(&x.len()) && x.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) && !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

fn clean_list(v: &Value, max: usize) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for s in list_of(v) {
        let s = s.trim().to_string();
        if !s.is_empty() && !out.contains(&s) { out.push(s); }
    }
    out.truncate(max);
    out
}

fn abs_folder(v: Option<&Value>, fallback: &str, label: &str) -> Result<String, String> {
    let Some(s) = v.and_then(Value::as_str) else { return Ok(fallback.to_string()) };
    let p = s.trim();
    if !is_abs(p) {
        return Err(format!("{label}: folder must be a full path"));
    }
    Ok(if p.len() > 3 { p.trim_end_matches(['\\', '/']).to_string() } else { p.to_string() })
}

// shortcut: no Unicode NFD, so accented letters become "-"; ids only, never shown.
fn slug(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut s = String::new();
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() { s.push(c) } else if !s.ends_with('-') { s.push('-') }
    }
    let s: String = s.trim_matches('-').chars().take(30).collect();
    format!("c-{}", if s.is_empty() { base36_now() } else { s })
}

fn obj(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| v.is_object())
}

pub fn merge(current: &Settings, patch: &Value, base_dir: &std::path::Path) -> Result<Settings, String> {
    let d = defaults(base_dir);
    let mut next = current.clone();
    if !patch.is_object() {
        return Ok(next);
    }
    let p = |k: &str| patch.get(k);

    if p("language").is_some() {
        next.language = one_of(p("language"), &["auto", "en", "pt-BR"], &next.language);
    }

    if let Some(g) = obj(p("general")) {
        let n = &mut next.general;
        n.start_with_windows = bool_(g.get("startWithWindows"), n.start_with_windows);
        n.monitor_clipboard = bool_(g.get("monitorClipboard"), n.monitor_clipboard);
        n.context_menu = bool_(g.get("contextMenu"), n.context_menu);
        n.bypass_key = one_of(g.get("bypassKey"), &["alt", "shift", "none"], &n.bypass_key);
        n.send_cookies = bool_(g.get("sendCookies"), n.send_cookies);
        n.allow_http_bridge = bool_(g.get("allowHttpBridge"), n.allow_http_bridge);
        if let Some(b) = obj(g.get("browsers")) {
            for name in BROWSERS {
                let cur = n.browsers.get(name).copied().unwrap_or(true);
                n.browsers.insert(name.to_string(), bool_(b.get(name), cur));
            }
        }
    }

    if let Some(ft) = obj(p("fileTypes")) {
        if let Some(v) = ft.get("capture") { next.file_types.capture = clean_exts(v); }
        if let Some(v) = ft.get("excludeSites") { next.file_types.exclude_sites = clean_list(v, 500); }
        if let Some(v) = ft.get("excludeUrls") { next.file_types.exclude_urls = clean_list(v, 500); }
    }

    if let Some(sv) = obj(p("save")) {
        next.save.set_file_date = bool_(sv.get("setFileDate"), next.save.set_file_date);
        if let Some(cats) = sv.get("categories").and_then(Value::as_array) {
            let mut out: Vec<Category> = vec![];
            for c in cats.iter().filter(|c| c.is_object()) {
                let existing = c.get("id").and_then(Value::as_str).and_then(|id| next.save.categories.iter().find(|x| x.id == id));
                let fresh_name = c.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty());
                let mut cat = match (existing, fresh_name) {
                    (Some(e), _) => e.clone(),
                    (None, Some(name)) => Category {
                        id: slug(name),
                        name: String::new(),
                        folder: base_dir.join(name.replace(['<', '>', ':', '"', '/', '\\', '|', '?', '*'], "_")).display().to_string(),
                        exts: vec![],
                        remember_last: true,
                    },
                    _ => continue,
                };
                if out.iter().any(|x| x.id == cat.id) { continue; }
                if !is_builtin_category(&cat.id) {
                    let n = str_(c.get("name"), &cat.name, 40).trim().to_string();
                    if !n.is_empty() { cat.name = n; }
                }
                if c.get("folder").is_some() {
                    let label = if cat.name.is_empty() { cat.id.clone() } else { cat.name.clone() };
                    cat.folder = abs_folder(c.get("folder"), &cat.folder, &label)?;
                }
                if let Some(e) = c.get("exts") { if cat.id != "general" { cat.exts = clean_exts(e); } }
                cat.remember_last = bool_(c.get("rememberLast"), cat.remember_last);
                out.push(cat);
            }
            // Built-in categories can't be deleted; custom ones are dropped when left out.
            for b in &d.save.categories {
                if !out.iter().any(|c| c.id == b.id) {
                    out.push(next.save.categories.iter().find(|c| c.id == b.id).unwrap_or(b).clone());
                }
            }
            if let Some(gi) = out.iter().position(|c| c.id == "general") {
                let g = out.remove(gi);
                out.push(g); // General stays last
            }
            next.save.categories = out;
        }
    }

    if let Some(dl) = obj(p("downloads")) {
        let n = &mut next.downloads;
        n.show_file_info = bool_(dl.get("showFileInfo"), n.show_file_info);
        n.show_progress = bool_(dl.get("showProgress"), n.show_progress);
        n.show_complete = bool_(dl.get("showComplete"), n.show_complete);
        n.duplicate = one_of(dl.get("duplicate"), &["ask", "number", "overwrite", "resume"], &n.duplicate);
        n.user_agent = str_(dl.get("userAgent"), &n.user_agent, 500).replace(['\r', '\n'], "");
        if let Some(av) = obj(dl.get("antivirus")) {
            n.antivirus.enabled = bool_(av.get("enabled"), n.antivirus.enabled);
            n.antivirus.program = str_(av.get("program"), &n.antivirus.program, 500);
            n.antivirus.args = str_(av.get("args"), &n.antivirus.args, 500);
        }
    }

    if let Some(cn) = obj(p("connection")) {
        let n = &mut next.connection;
        n.max_connections = clamp_int(cn.get("maxConnections"), 1, 32, n.max_connections);
        n.max_active = clamp_int(cn.get("maxActive"), 1, 20, n.max_active);
        if let Some(ex) = cn.get("exceptions").and_then(Value::as_array) {
            n.exceptions = ex
                .iter()
                .filter_map(|e| {
                    let host = e.get("host")?.as_str()?.trim();
                    (!host.is_empty()).then(|| Exception { host: host.to_lowercase().chars().take(200).collect(), max: clamp_int(e.get("max"), 1, 32, 1) })
                })
                .take(100)
                .collect();
        }
        if let Some(q) = obj(cn.get("quota")) {
            let o = &mut n.quota;
            o.enabled = bool_(q.get("enabled"), o.enabled);
            o.mb = clamp_int(q.get("mb"), 1, 10_000_000, o.mb);
            o.hours = clamp_int(q.get("hours"), 1, 24 * 31, o.hours);
            o.warn = bool_(q.get("warn"), o.warn);
        }
    }

    if let Some(px) = obj(p("proxy")) {
        let n = &mut next.proxy;
        n.mode = one_of(px.get("mode"), &["none", "system", "pac", "manual"], &n.mode);
        n.pac_url = str_(px.get("pacUrl"), &n.pac_url, 1000).trim().to_string();
        n.kind = one_of(px.get("type"), &["http", "socks5"], &n.kind);
        n.host = str_(px.get("host"), &n.host, 255).trim().to_string();
        n.port = clamp_int(px.get("port"), 1, 65535, n.port);
        n.user = str_(px.get("user"), &n.user, 255);
        n.pass = str_(px.get("pass"), &n.pass, 255);
    }

    if let Some(sites) = p("sites").and_then(Value::as_array) {
        next.sites = sites
            .iter()
            .filter_map(|s| {
                let site = s.get("site")?.as_str()?.trim();
                (!site.is_empty()).then(|| Site { site: site.chars().take(500).collect(), user: str_(s.get("user"), "", 255), pass: str_(s.get("pass"), "", 255) })
            })
            .take(500)
            .collect();
    }

    if let Some(r) = obj(p("retry")) {
        next.retry.attempts = clamp_int(r.get("attempts"), 0, 1000, next.retry.attempts);
        next.retry.delay = clamp_int(r.get("delay"), 1, 3600, next.retry.delay);
    }

    if let Some(snd) = obj(p("sounds")) {
        for e in SOUND_EVENTS {
            let Some(s) = obj(snd.get(e)) else { continue };
            let cur = next.sounds.entry(e.to_string()).or_insert(Sound { enabled: false, file: String::new() });
            cur.enabled = bool_(s.get("enabled"), cur.enabled);
            cur.file = str_(s.get("file"), &cur.file, 1000);
        }
    }

    if let Some(sl) = obj(p("speedLimit")) {
        next.speed_limit.enabled = bool_(sl.get("enabled"), next.speed_limit.enabled);
        next.speed_limit.kbps = clamp_int(sl.get("kbps"), 1, 10_000_000, next.speed_limit.kbps);
    }

    if let Some(ui) = obj(p("ui")) {
        let n = &mut next.ui;
        n.theme = one_of(ui.get("theme"), &["system", "light", "dark"], &n.theme);
        n.hide_categories = bool_(ui.get("hideCategories"), n.hide_categories);
        n.toolbar = one_of(ui.get("toolbar"), &["large", "small", "hidden"], &n.toolbar);
        n.font_size = clamp_int(ui.get("fontSize"), 11, 18, n.font_size);
        n.sort_by = one_of(ui.get("sortBy"), &["addedAt", "name", "size", "status", "lastTry", "category", "description", "rate", "timeLeft", "queue"], &n.sort_by);
        n.sort_dir = one_of(ui.get("sortDir"), &["asc", "desc"], &n.sort_dir);
        n.close_to_tray = bool_(ui.get("closeToTray"), n.close_to_tray);
        if let Some(cols) = obj(ui.get("columns")) {
            for c in COLUMNS {
                let cur = n.columns.get(c).copied().unwrap_or(true);
                n.columns.insert(c.to_string(), c == "name" || bool_(cols.get(c), cur));
            }
        }
        if let Some(w) = obj(ui.get("columnWidths")) {
            for c in COLUMNS {
                if w.get(c).is_some() { n.column_widths.insert(c.to_string(), clamp_int(w.get(c), 40, 800, 120)); }
            }
        }
    }

    if let Some(qs) = p("queues").and_then(Value::as_array) {
        let mut out: Vec<Queue> = vec![];
        for q in qs.iter().filter(|q| q.is_object()) {
            let id = match q.get("id").and_then(Value::as_str) {
                Some(id) if ID.is_match(id) => id.to_string(),
                _ => format!("q-{}{}", base36_now(), out.len()),
            };
            if out.iter().any(|x| x.id == id) { continue; }
            let cur = next.queues.iter().find(|x| x.id == id).cloned().unwrap_or_else(|| default_queue(&id, ""));
            let empty = Value::Object(Default::default());
            let s = obj(q.get("schedule")).unwrap_or(&empty);
            let name = str_(q.get("name"), &cur.name, 60);
            let start_date = match s.get("startDate").and_then(Value::as_str) {
                Some(d) if d.is_empty() || DATE.is_match(d) => d.to_string(),
                _ => cur.schedule.start_date.clone(),
            };
            let days = match s.get("days").and_then(Value::as_array) {
                Some(a) => {
                    let mut v: Vec<u8> = a.iter().filter_map(|n| n.as_f64()).filter(|n| n.fract() == 0.0 && (0.0..=6.0).contains(n)).map(|n| n as u8).collect();
                    v.sort();
                    v.dedup();
                    v
                }
                None => cur.schedule.days.clone(),
            };
            out.push(Queue {
                name: if id == "main" { name } else if name.trim().is_empty() { "Queue".into() } else { name.trim().to_string() },
                max_concurrent: clamp_int(q.get("maxConcurrent"), 1, 20, cur.max_concurrent),
                schedule: Schedule {
                    enabled: bool_(s.get("enabled"), cur.schedule.enabled),
                    start_mode: one_of(s.get("startMode"), &["once", "daily"], &cur.schedule.start_mode),
                    start_time: time(s.get("startTime"), &cur.schedule.start_time),
                    start_date,
                    days,
                    stop_enabled: bool_(s.get("stopEnabled"), cur.schedule.stop_enabled),
                    stop_time: time(s.get("stopTime"), &cur.schedule.stop_time),
                    after_finish: one_of(s.get("afterFinish"), &["none", "exit", "shutdown", "sleep"], &cur.schedule.after_finish),
                },
                id,
            });
        }
        if !out.iter().any(|q| q.id == "main") {
            out.insert(0, next.queues.iter().find(|q| q.id == "main").cloned().unwrap_or_else(|| default_queue("main", "")));
        }
        out.truncate(50);
        next.queues = out;
    }

    if let Some(gp) = p("grabberProjects").and_then(Value::as_array) {
        next.grabber_projects = gp
            .iter()
            .filter_map(|g| {
                let url = g.get("url")?.as_str()?.trim();
                let lower = url.to_ascii_lowercase();
                (lower.starts_with("http://") || lower.starts_with("https://")).then_some((g, url))
            })
            .enumerate()
            .map(|(n, (g, url))| GrabberProject {
                id: match g.get("id").and_then(Value::as_str) { Some(id) if ID.is_match(id) => id.to_string(), _ => format!("g-{}{n}", base36_now()) },
                name: { let s = str_(g.get("name"), "", 80).trim().to_string(); if s.is_empty() { url.chars().take(80).collect() } else { s } },
                url: url.chars().take(2000).collect(),
                depth: clamp_int(g.get("depth"), 0, 3, 1),
                exts: clean_exts(g.get("exts").unwrap_or(&Value::Null)),
                same_site: bool_(g.get("sameSite"), true),
            })
            .take(100)
            .collect();
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> std::path::PathBuf { std::path::PathBuf::from(r"C:\Downloads") }

    #[test]
    fn clamps_and_validates() {
        let d = defaults(&base());
        let s = merge(&d, &json!({ "connection": { "maxConnections": 99, "maxActive": "4" }, "ui": { "theme": "neon", "fontSize": 5 } }), &base()).unwrap();
        assert_eq!(s.connection.max_connections, 32);
        assert_eq!(s.connection.max_active, 4);
        assert_eq!(s.ui.theme, "system");
        assert_eq!(s.ui.font_size, 11);
    }

    #[test]
    fn categories_keep_builtins_and_general_last() {
        let d = defaults(&base());
        let s = merge(&d, &json!({ "save": { "categories": [{ "id": "general" }, { "name": "Books", "exts": ".EPUB, mobi" }] } }), &base()).unwrap();
        assert_eq!(s.save.categories.last().unwrap().id, "general");
        let books = s.save.categories.iter().find(|c| c.name == "Books").unwrap();
        assert_eq!(books.id, "c-books");
        assert_eq!(books.exts, vec!["epub", "mobi"]);
        assert_eq!(s.save.categories.len(), 7);
        assert!(merge(&d, &json!({ "save": { "categories": [{ "id": "music", "folder": "relative" }] } }), &base()).is_err());
    }

    #[test]
    fn queues_always_have_main() {
        let d = defaults(&base());
        let s = merge(&d, &json!({ "queues": [{ "id": "night", "name": " ", "schedule": { "days": [6, 1, 1, 9], "startTime": "25:00" } }] }), &base()).unwrap();
        assert_eq!(s.queues[0].id, "main");
        assert_eq!(s.queues[1].name, "Queue");
        assert_eq!(s.queues[1].schedule.days, vec![1, 6]);
        assert_eq!(s.queues[1].schedule.start_time, "03:00");
    }

    #[test]
    fn json_shape_matches_ui() {
        let v = serde_json::to_value(defaults(&base())).unwrap();
        assert!(v.pointer("/fileTypes/excludeSites").is_some());
        assert_eq!(v.pointer("/proxy/type").unwrap(), "http");
        assert_eq!(v.pointer("/ui/columns").unwrap().as_object().unwrap().keys().next().unwrap(), "name");
    }
}
