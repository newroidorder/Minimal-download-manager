//! HTTP plumbing: the client (with the proxy from Options), requests with
//! safe redirect handling, and helpers that read names and ranges.

use crate::rules::decode;
use crate::settings::Proxy;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Response};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use url::Url;

pub type Headers = Vec<(String, String)>;

/// Resolves the proxy for a URL in "system" and "pac" modes; returns a rule
/// like "PROXY host:port; DIRECT" or "host:port". Supplied by the app (WinHTTP).
pub type ProxyResolver = Arc<dyn Fn(&Url) -> Option<String> + Send + Sync>;

#[derive(Debug, Clone)]
pub struct HttpError {
    pub message: String,
    pub status: Option<u16>,
}

impl HttpError {
    pub fn msg(m: impl Into<String>) -> Self {
        HttpError { message: m.into(), status: None }
    }
    pub fn status(s: u16) -> Self {
        let message = if s == 401 || s == 407 { format!("HTTP {s} (login required)") } else { format!("HTTP {s}") };
        HttpError { message, status: Some(s) }
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<reqwest::Error> for HttpError {
    fn from(e: reqwest::Error) -> Self {
        let m = if e.is_timeout() { "connection timed out".to_string() } else if e.is_connect() { format!("could not connect: {}", root(&e)) } else { root(&e) };
        HttpError::msg(m)
    }
}

fn root(e: &dyn std::error::Error) -> String {
    let mut cur = e;
    while let Some(s) = cur.source() {
        cur = s;
    }
    cur.to_string()
}

/// "PROXY host:port; SOCKS5 host:port; DIRECT" (or WinHTTP's "host:port") -> first usable entry.
pub fn parse_rule(rule: &str) -> Option<Url> {
    for part in rule.split(';') {
        let mut words = part.split_whitespace();
        while let Some(w) = words.next() {
            let (scheme, addr) = match w.to_ascii_uppercase().as_str() {
                "DIRECT" => return None,
                "SOCKS" | "SOCKS5" => ("socks5h", words.next().unwrap_or("")),
                "PROXY" | "HTTPS" => ("http", words.next().unwrap_or("")),
                _ => ("http", w.split_once('=').map_or(w, |(_, a)| a)), // WinHTTP: "host:port" or "http=host:port"
            };
            if let Ok(u) = Url::parse(&format!("{scheme}://{addr}")) {
                if u.host_str().is_some_and(|h| !h.is_empty()) {
                    return Some(u);
                }
            }
        }
    }
    None
}

/// HTTP/1.1 only: every segment gets its own TCP connection (HTTP/2 would
/// squeeze them all into one). Redirects are followed by hand in `open`.
pub fn build_client(p: &Proxy, resolver: Option<ProxyResolver>) -> Client {
    let mut b = Client::builder()
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(30))
        .tcp_nodelay(true)
        .pool_max_idle_per_host(32);
    match p.mode.as_str() {
        "manual" if !p.host.is_empty() => {
            let scheme = if p.kind == "socks5" { "socks5h" } else { "http" };
            if let Ok(mut u) = Url::parse(&format!("{scheme}://{}:{}", p.host, p.port)) {
                if !p.user.is_empty() && scheme == "socks5h" {
                    let _ = u.set_username(&p.user);
                    let _ = u.set_password(Some(&p.pass));
                }
                if let Ok(mut proxy) = reqwest::Proxy::all(u.as_str()) {
                    if !p.user.is_empty() && scheme == "http" {
                        proxy = proxy.basic_auth(&p.user, &p.pass);
                    }
                    b = b.proxy(proxy);
                }
            }
        }
        "system" | "pac" if resolver.is_some() => {
            let r = resolver.unwrap();
            b = b.proxy(reqwest::Proxy::custom(move |u| r(u).and_then(|rule| parse_rule(&rule))));
        }
        "system" => {} // reqwest reads the Windows proxy settings by itself
        _ => b = b.no_proxy(),
    }
    b.build().unwrap_or_default()
}

fn header_map(h: &Headers) -> HeaderMap {
    let mut m = HeaderMap::new();
    for (k, v) in h {
        if let (Ok(k), Ok(v)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            m.append(k, v);
        }
    }
    m
}

pub fn with(h: &Headers, k: &str, v: String) -> Headers {
    let mut out: Headers = h.iter().filter(|(x, _)| !x.eq_ignore_ascii_case(k)).cloned().collect();
    out.push((k.to_string(), v));
    out
}

pub async fn cancellable<T>(cancel: &CancellationToken, f: impl std::future::Future<Output = Result<T, HttpError>>) -> Result<T, HttpError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(HttpError::msg("aborted")),
        r = f => r,
    }
}

pub struct Opened {
    pub res: Response,
    pub url: Url,
    pub headers: Headers,
}

/// GET that follows redirects. Cookies and logins never go to another origin.
pub async fn open(client: &Client, url: &str, headers: &Headers, cancel: &CancellationToken) -> Result<Opened, HttpError> {
    let mut url = Url::parse(url).map_err(|e| HttpError::msg(e.to_string()))?;
    let mut headers = headers.clone();
    for _ in 0..=10 {
        let req = client.get(url.clone()).headers(header_map(&headers));
        let res = cancellable(cancel, async { Ok(req.send().await?) }).await?;
        let s = res.status().as_u16();
        let loc = res.headers().get("location").and_then(|v| v.to_str().ok()).map(String::from);
        if let (true, Some(loc)) = (matches!(s, 301 | 302 | 303 | 307 | 308), loc) {
            let next = url.join(&loc).map_err(|e| HttpError::msg(e.to_string()))?;
            if next.scheme() != "http" && next.scheme() != "https" {
                return Err(HttpError::msg(format!("refusing redirect to {}:", next.scheme())));
            }
            if next.origin() != url.origin() {
                headers.retain(|(k, _)| !k.eq_ignore_ascii_case("cookie") && !k.eq_ignore_ascii_case("authorization"));
            }
            url = next;
            continue;
        }
        if s >= 400 {
            return Err(HttpError::status(s));
        }
        return Ok(Opened { res, url, headers });
    }
    Err(HttpError::msg("too many redirects"))
}

pub fn header<'a>(res: &'a Response, name: &str) -> Option<&'a str> {
    res.headers().get(name).and_then(|v| v.to_str().ok())
}

static STAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)").unwrap());
static PLAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"filename\s*=\s*("([^"]*)"|[^;]+)"#).unwrap());
static CR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^bytes (\d+)-(\d+)/(\d+|\*)$").unwrap());

pub fn filename_from_disposition(cd: Option<&str>) -> Option<String> {
    let cd = cd?;
    if let Some(m) = STAR.captures(cd) {
        if let Some(n) = decode(m[1].trim()) {
            return Some(n);
        }
    }
    let m = PLAIN.captures(cd)?;
    Some(m.get(2).or(m.get(1))?.as_str().trim().to_string())
}

pub fn filename_from_url(url: &str) -> Option<String> {
    let u = Url::parse(url).ok()?;
    let last = u.path().rsplit('/').next()?;
    if last.is_empty() { None } else { decode(last) }
}

pub fn sanitize(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '_' } else { c }).collect();
    let clean: String = clean.trim_matches(|c: char| c == '.' || c.is_whitespace()).chars().take(200).collect();
    if clean.is_empty() { format!("download_{}", crate::now_ms()) } else { clean }
}

pub struct ContentRange {
    pub start: u64,
    pub total: Option<u64>,
}

pub fn parse_content_range(v: Option<&str>) -> Option<ContentRange> {
    let m = CR.captures(v?)?;
    Some(ContentRange { start: m[1].parse().ok()?, total: m[3].parse().ok() })
}

/// Content-Range if the reply is 206, else None.
pub fn range_of(res: &Response) -> Option<ContentRange> {
    if res.status().as_u16() == 206 { parse_content_range(header(res, "content-range")) } else { None }
}

/// A strong ETag, or else Last-Modified, lets a resumed request use If-Range.
pub fn validator_of(res: &Response) -> Option<String> {
    match header(res, "etag") {
        Some(e) if !e.starts_with("W/") => Some(e.to_string()),
        _ => header(res, "last-modified").map(String::from),
    }
}

pub fn mime_of(res: &Response) -> String {
    header(res, "content-type").unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase()
}

pub struct Info {
    pub filename: String,
    pub size: u64,
    pub mime: String,
    pub can_range: bool,
}

/// Reads a file's name, size and type without downloading it (for the "New
/// download" window). The probe connection is closed right away.
pub async fn inspect(client: &Client, url: &str, headers: &Headers) -> Result<Info, HttpError> {
    let o = open(client, url, &with(headers, "Range", "bytes=0-".into()), &CancellationToken::new()).await?;
    let cr = range_of(&o.res).filter(|c| c.start == 0 && c.total.is_some());
    let size = match &cr {
        Some(c) => c.total.unwrap_or(0),
        None if o.res.status().as_u16() == 200 => o.res.content_length().unwrap_or(0),
        None => 0,
    };
    let name = filename_from_disposition(header(&o.res, "content-disposition")).or_else(|| filename_from_url(o.url.as_str()));
    Ok(Info { filename: sanitize(&name.unwrap_or_default()), size, mime: mime_of(&o.res), can_range: cr.is_some() })
}

pub struct Page {
    pub url: String,
    pub content_type: String,
    pub text: Option<String>,
}

/// For the Site Explorer: fetches a page and returns its text if it is HTML.
pub async fn fetch_page(client: &Client, url: &str, headers: &Headers, cancel: &CancellationToken) -> Result<Page, HttpError> {
    let mut o = open(client, url, headers, cancel).await?;
    let content_type = header(&o.res, "content-type").unwrap_or("").to_string();
    if !content_type.to_lowercase().contains("html") {
        return Ok(Page { url: o.url.to_string(), content_type, text: None });
    }
    let mut body = Vec::new();
    while let Some(c) = cancellable(cancel, async { Ok(o.res.chunk().await?) }).await? {
        body.extend_from_slice(&c);
        if body.len() > 5 * 1024 * 1024 {
            break;
        }
    }
    Ok(Page { url: o.url.to_string(), content_type, text: Some(String::from_utf8_lossy(&body).into_owned()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(filename_from_disposition(Some("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).unwrap(), "résumé.pdf");
        assert_eq!(filename_from_disposition(Some(r#"attachment; filename="a b.zip""#)).unwrap(), "a b.zip");
        assert_eq!(filename_from_url("https://x.com/dir/My%20File.zip?x=1").unwrap(), "My File.zip");
        assert_eq!(filename_from_url("https://x.com/"), None);
        assert_eq!(sanitize("..\\evil/..\\con:x?.exe. "), "con_x_.exe");
        assert!(sanitize("...").starts_with("download_"));
    }

    #[test]
    fn rules() {
        assert_eq!(parse_rule("PROXY p.lan:8080; DIRECT").unwrap().as_str(), "http://p.lan:8080/");
        assert_eq!(parse_rule("SOCKS5 s:1080").unwrap().scheme(), "socks5h");
        assert_eq!(parse_rule("10.0.0.1:3128").unwrap().port(), Some(3128));
        assert!(parse_rule("DIRECT").is_none());
    }
}
