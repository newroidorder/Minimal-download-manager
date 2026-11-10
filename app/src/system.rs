//! Windows integration: antivirus scan, power actions after a queue, the
//! clipboard monitor, staying awake, start with Windows, the minimaldm:// link
//! type and the proxy from Windows / a PAC script.

use mdm_core::http::ProxyResolver;
use mdm_core::settings::SettingsStore;
use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use url::Url;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// Splits an argument string like: -Scan -File "%f" (quotes group words).
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut it = s.chars().peekable();
    while let Some(&c) = it.peek() {
        if c.is_whitespace() {
            it.next();
        } else if c == '"' {
            it.next();
            out.push(it.by_ref().take_while(|&c| c != '"').collect());
        } else {
            let mut w = String::new();
            while let Some(&c) = it.peek() {
                if c.is_whitespace() {
                    break;
                }
                w.push(c);
                it.next();
            }
            out.push(w);
        }
    }
    out
}

/// Runs the antivirus on a finished file; %f is replaced by the file path.
pub async fn run_program(program: String, args: String, file: String) -> Result<i32, String> {
    let mut list: Vec<String> = split_args(&args).into_iter().map(|a| a.replace("%f", &file)).collect();
    if !args.contains("%f") {
        list.push(file);
    }
    let mut child = tokio::process::Command::new(&program)
        .args(&list)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    match tokio::time::timeout(Duration::from_secs(600), child.wait()).await {
        Ok(Ok(s)) => Ok(s.code().unwrap_or(1)),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Ok(1), // killed on drop after 10 minutes
    }
}

fn detached(cmd: &str, args: &[&str]) {
    let _ = Command::new(cmd).args(args).creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS).spawn();
}

/// Windows shows its own 60 s warning; "shutdown /a" cancels it.
pub fn shutdown(message: &str) {
    detached("shutdown", &["/s", "/t", "60", "/c", message]);
}
pub fn cancel_shutdown() {
    detached("shutdown", &["/a"]);
}
pub fn sleep() {
    detached("rundll32.exe", &["powrprof.dll,SetSuspendState", "0,1,0"]);
}

pub fn is_link(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")) && text.len() < 4000 && !text.contains(char::is_whitespace) && text.len() > 8
}

pub fn clipboard_text() -> String {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default()
}

pub fn set_clipboard(text: &str) {
    if let Ok(mut c) = arboard::Clipboard::new() {
        let _ = c.set_text(text.to_string());
    }
}

/// Calls on_url when a new single download link is copied.
pub fn watch_clipboard(enabled: impl Fn() -> bool + Send + 'static, on_url: impl Fn(String) + Send + 'static) {
    std::thread::spawn(move || {
        let mut last = clipboard_text();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if !enabled() {
                continue;
            }
            let text = clipboard_text().trim().to_string();
            if text == last {
                continue;
            }
            last = text.clone();
            if is_link(&text) {
                on_url(text);
            }
        }
    });
}

/// Keeps Windows from sleeping while busy() is true. The execution state is
/// per thread, so one thread owns it.
pub fn keep_awake(busy: impl Fn() -> bool + Send + 'static) {
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
    std::thread::spawn(move || {
        let mut on = false;
        loop {
            let b = busy();
            if b != on {
                on = b;
                unsafe { SetThreadExecutionState(if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS }) };
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Minimal Download Manager";

pub fn set_autostart(on: bool) {
    let Ok((key, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY) else { return };
    let _ = key.delete_value("com.minimaldm.app"); // the Electron version's entry (its AppUserModelId)
    match (on, std::env::current_exe()) {
        (true, Ok(exe)) => {
            let _ = key.set_value(RUN_VALUE, &format!("\"{}\" --hidden", exe.display()));
        }
        _ => {
            let _ = key.delete_value(RUN_VALUE);
        }
    }
}

/// minimaldm://add?url=... opens the "New download" window.
pub fn register_link_type() {
    let Ok(exe) = std::env::current_exe() else { return };
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok((k, _)) = hkcu.create_subkey(r"Software\Classes\minimaldm") {
        let _ = k.set_value("", &"URL:Minimal Download Manager");
        let _ = k.set_value("URL Protocol", &"");
        if let Ok((cmd, _)) = k.create_subkey(r"shell\open\command") {
            let _ = cmd.set_value("", &format!("\"{}\" \"%1\"", exe.display()));
        }
    }
    let _ = hkcu.delete_subkey_all(r"Software\Classes\miniidm"); // the link type of 2.2.1 and older
}

// ---------- proxy: Windows settings and PAC scripts through WinHTTP ----------

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn take_wide(p: *mut u16) -> Option<String> {
    use windows_sys::Win32::Foundation::GlobalFree;
    if p.is_null() {
        return None;
    }
    let len = (0..).take_while(|&i| *p.add(i) != 0).count();
    let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
    GlobalFree(p as _);
    Some(s)
}

/// Asks WinHTTP which proxy serves `url`. pac: a script address, or None to
/// use the Windows settings (auto-detect / script / fixed proxy).
fn winhttp_proxy(url: &str, pac: Option<&str>) -> Option<String> {
    use windows_sys::Win32::Networking::WinHttp::*;
    unsafe {
        let mut auto_detect = false;
        let mut script = pac.map(String::from);
        if pac.is_none() {
            let mut ie: WINHTTP_CURRENT_USER_IE_PROXY_CONFIG = std::mem::zeroed();
            if WinHttpGetIEProxyConfigForCurrentUser(&mut ie) == 0 {
                return None;
            }
            auto_detect = ie.fAutoDetect != 0;
            script = take_wide(ie.lpszAutoConfigUrl);
            let fixed = take_wide(ie.lpszProxy);
            take_wide(ie.lpszProxyBypass);
            if script.is_none() && !auto_detect {
                return fixed;
            }
        }
        let session = WinHttpOpen(wide("Minimal Download Manager").as_ptr(), WINHTTP_ACCESS_TYPE_NO_PROXY, std::ptr::null(), std::ptr::null(), 0);
        if session.is_null() {
            return None;
        }
        let script_w = script.as_deref().map(wide);
        let mut opts: WINHTTP_AUTOPROXY_OPTIONS = std::mem::zeroed();
        opts.dwFlags = if script_w.is_some() { WINHTTP_AUTOPROXY_CONFIG_URL } else { WINHTTP_AUTOPROXY_AUTO_DETECT };
        opts.dwAutoDetectFlags = if auto_detect || script_w.is_none() { WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A } else { 0 };
        if let Some(w) = &script_w {
            opts.lpszAutoConfigUrl = w.as_ptr();
        }
        opts.fAutoLogonIfChallenged = 1;
        let mut info: WINHTTP_PROXY_INFO = std::mem::zeroed();
        let ok = WinHttpGetProxyForUrl(session, wide(url).as_ptr(), &mut opts, &mut info) != 0;
        WinHttpCloseHandle(session);
        let proxy = take_wide(info.lpszProxy);
        take_wide(info.lpszProxyBypass);
        if ok && info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY { proxy } else { None }
    }
}

/// For "system" and "pac" modes. Answers are cached per site and mode.
// shortcut: cache lives until the proxy settings change (new resolver); upgrade to a TTL if PAC scripts rotate often.
pub fn proxy_resolver(settings: Arc<SettingsStore>) -> ProxyResolver {
    let cache: Mutex<HashMap<String, Option<String>>> = Mutex::new(HashMap::new());
    Arc::new(move |u: &Url| {
        let p = settings.get().proxy.clone();
        let key = format!("{}|{}|{}://{}", p.mode, p.pac_url, u.scheme(), u.host_str().unwrap_or(""));
        if let Some(hit) = cache.lock().unwrap().get(&key) {
            return hit.clone();
        }
        let pac = (p.mode == "pac").then_some(p.pac_url.as_str()).filter(|s| !s.is_empty());
        if p.mode == "pac" && pac.is_none() {
            return None;
        }
        // Blocks once per site while WinHTTP fetches the script; cached after that.
        let r = winhttp_proxy(u.as_str(), pac);
        cache.lock().unwrap().insert(key, r.clone());
        r
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args() {
        assert_eq!(split_args(r#"-Scan -ScanType 3 -File "%f""#), ["-Scan", "-ScanType", "3", "-File", "%f"]);
        assert_eq!(split_args(r#"/scan "C:\a b\x.zip""#), ["/scan", r"C:\a b\x.zip"]);
    }

    #[test]
    fn links() {
        assert!(is_link("https://a.com/x.zip"));
        assert!(!is_link("see https://a.com"));
        assert!(!is_link("ftp://a.com/x"));
    }
}
