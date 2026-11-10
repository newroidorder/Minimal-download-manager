//! Decisions made from the Options: which browser downloads to capture
//! (File types tab), and which login to send to which site (Sites tab).

use crate::settings::{ext_of, Settings, Site};
use base64::Engine;
use url::Url;

fn mime_ext(mime: &str) -> &'static str {
    match mime {
        "application/zip" | "application/x-zip-compressed" | "application/x-zip" | "multipart/x-zip" => "zip",
        "application/x-rar" | "application/x-rar-compressed" | "application/vnd.rar" => "rar",
        "application/x-msdos-program" | "application/x-dosexec" | "application/vnd.microsoft.portable-executable" | "application/x-msdownload" => "exe",
        "application/x-7z-compressed" => "7z",
        "application/gzip" | "application/x-gzip" => "gz",
        "application/x-tar" => "tar",
        "application/x-msi" | "application/x-ms-installer" => "msi",
        "application/vnd.android.package-archive" => "apk",
        "application/x-iso9660-image" => "iso",
        "application/pdf" => "pdf",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/flac" => "flac",
        "audio/ogg" => "ogg",
        "video/mp4" => "mp4",
        "video/x-matroska" => "mkv",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/x-msvideo" => "avi",
        _ => "",
    }
}

/// Types servers use for "just a file" (S3 sends binary/octet-stream).
fn generic_binary(mime: &str) -> bool {
    let m = mime.to_ascii_lowercase();
    let base = m.split([';', ' ']).next().unwrap_or("");
    matches!(
        base,
        "application/octet-stream" | "application/force-download" | "application/x-download" | "application/download"
            | "application/binary" | "application/x-binary" | "application/unknown" | "binary/octet-stream"
    )
}

/// "*.example.com" matches example.com and every subdomain; "example.com" matches exactly.
pub fn host_matches(pattern: &str, host: &str) -> bool {
    let p = pattern.to_lowercase();
    let p = p.strip_prefix("http://").or_else(|| p.strip_prefix("https://")).unwrap_or(&p);
    let p = p.split('/').next().unwrap_or("");
    let h = host.to_lowercase();
    match p.strip_prefix("*.") {
        Some(rest) => h == rest || h.ends_with(&p[1..]),
        None => h == p,
    }
}

/// "*" wildcards in a full URL pattern, case-insensitive.
pub fn url_matches(pattern: &str, url: &str) -> bool {
    let re = pattern.split('*').map(regex::escape).collect::<Vec<_>>().join(".*");
    regex::RegexBuilder::new(&format!("^{re}$")).case_insensitive(true).build().is_ok_and(|r| r.is_match(url))
}

pub fn decode(s: &str) -> Option<String> {
    percent_encoding::percent_decode_str(s).decode_utf8().ok().map(|c| c.into_owned())
}

pub fn file_ext(url: &str, filename: Option<&str>, mime: Option<&str>) -> String {
    let mut ext = ext_of(filename.unwrap_or(""));
    if ext.is_empty() {
        if let Ok(u) = Url::parse(url) {
            ext = ext_of(&decode(u.path()).unwrap_or_default());
        }
    }
    if ext.is_empty() {
        if let Some(m) = mime {
            ext = mime_ext(m.split(';').next().unwrap_or("").trim().to_lowercase().as_str()).to_string();
        }
    }
    ext
}

pub struct Decision {
    pub capture: bool,
    pub reason: Option<String>,
}

fn no(reason: impl Into<String>) -> Decision {
    Decision { capture: false, reason: Some(reason.into()) }
}

/// kind: "auto" (browser started it), "click" (link click), or an explicit user
/// action ("menu", "detected", "manual"), which is always accepted.
pub fn capture_decision(s: &Settings, url: &str, filename: Option<&str>, mime: Option<&str>, browser: Option<&str>, kind: &str) -> Decision {
    if kind != "auto" && kind != "click" {
        return Decision { capture: true, reason: None };
    }
    if let Some(b) = browser {
        if s.general.browsers.get(b) == Some(&false) {
            return no("browser disabled");
        }
    }
    let Some(host) = Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)) else { return no("bad URL") };
    if s.file_types.exclude_sites.iter().any(|p| host_matches(p, &host)) {
        return no("site excluded");
    }
    if s.file_types.exclude_urls.iter().any(|p| url_matches(p, url)) {
        return no("address excluded");
    }
    let ext = file_ext(url, filename, mime);
    if ext.is_empty() && generic_binary(mime.unwrap_or("")) {
        return Decision { capture: true, reason: None };
    }
    if !s.file_types.capture.contains(&ext) {
        return no(if ext.is_empty() { "unknown file type".to_string() } else { format!(".{ext} is not in the file types list") });
    }
    Decision { capture: true, reason: None }
}

pub fn basic(user: &str, pass: &str) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}")))
}

/// Sites & logins: "example.com", "*.example.com" or "example.com/private/".
/// A saved login is only sent over HTTPS, so it can't be read on the way. The
/// one exception is a site the user entered as "http://..." on purpose.
pub fn credentials_for(sites: &[Site], url: &str) -> Option<String> {
    let u = Url::parse(url).ok()?;
    let https = u.scheme() == "https";
    if !https && u.scheme() != "http" {
        return None;
    }
    let mut best: Option<(usize, &Site)> = None;
    for s in sites {
        let lower = s.site.to_ascii_lowercase();
        let plain_http = lower.starts_with("http://");
        if https == plain_http {
            continue;
        }
        let raw = if plain_http { &s.site[7..] } else if lower.starts_with("https://") { &s.site[8..] } else { &s.site[..] };
        let (host, prefix) = match raw.find('/') { Some(i) => (&raw[..i], &raw[i..]), None => (raw, "/") };
        if !host_matches(host, u.host_str().unwrap_or("")) || !u.path().starts_with(prefix) {
            continue;
        }
        if best.is_none_or(|(len, _)| prefix.len() > len) {
            best = Some((prefix.len(), s));
        }
    }
    best.map(|(_, s)| basic(&s.user, &s.pass))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::defaults;

    fn site(s: &str) -> Site { Site { site: s.into(), user: "u".into(), pass: "p".into() } }

    #[test]
    fn hosts() {
        assert!(host_matches("*.example.com", "example.com"));
        assert!(host_matches("*.example.com", "a.b.example.com"));
        assert!(!host_matches("*.example.com", "badexample.com"));
        assert!(host_matches("https://Example.com/x", "example.com"));
        assert!(url_matches("https://x.com/*.zip", "HTTPS://x.com/a/b.zip"));
        assert!(!url_matches("https://x.com/*.zip", "https://x.com/a.zip?no"));
    }

    #[test]
    fn capture() {
        let s = defaults(std::path::Path::new("C:\\d"));
        assert!(capture_decision(&s, "https://a.com/f.zip", None, None, None, "auto").capture);
        assert!(!capture_decision(&s, "https://a.com/page.html", None, None, None, "auto").capture);
        assert!(capture_decision(&s, "https://a.com/x", None, Some("binary/octet-stream"), None, "auto").capture);
        assert!(capture_decision(&s, "https://a.com/x", None, Some("application/x-msdownload"), None, "click").capture);
        assert!(!capture_decision(&s, "https://download.windowsupdate.com/a.exe", None, None, None, "auto").capture);
        assert!(capture_decision(&s, "https://a.com/page.html", None, None, None, "menu").capture);
    }

    #[test]
    fn logins_https_only_longest_prefix() {
        let sites = vec![site("example.com"), Site { pass: "deep".into(), ..site("example.com/private/") }, site("http://router.lan")];
        assert_eq!(credentials_for(&sites, "http://example.com/a"), None);
        assert_eq!(credentials_for(&sites, "https://example.com/private/x"), Some(basic("u", "deep")));
        assert_eq!(credentials_for(&sites, "https://example.com/a"), Some(basic("u", "p")));
        assert_eq!(credentials_for(&sites, "http://router.lan/"), Some(basic("u", "p")));
        assert_eq!(credentials_for(&sites, "https://router.lan/"), None);
    }
}
