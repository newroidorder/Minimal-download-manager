//! Site Explorer: explores a web page (and, up to a depth, the pages it links
//! to on the same site) and lists the files that match the chosen types.

use crate::http::Page;
use crate::rules::decode;
use crate::settings::ext_of;
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::future::Future;
use std::sync::LazyLock;
use tokio_util::sync::CancellationToken;
use url::Url;

static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\b(?:href|src|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))"#).unwrap());
static SRCSET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap());
static BASE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)<base\s[^>]*href\s*=\s*["']([^"']+)["']"#).unwrap());
static SKIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(javascript|mailto|tel|data|blob):").unwrap());
static PAGE_EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(html?|php|aspx?|jsp)$").unwrap());

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&").replace("&#38;", "&").replace("&quot;", "\"").replace("&#39;", "'")
}

pub fn extract_links(html: &str, base_url: &str) -> Vec<String> {
    let Ok(base) = Url::parse(base_url) else { return vec![] };
    let root = BASE.captures(html).and_then(|m| base.join(&decode_entities(&m[1])).ok()).unwrap_or(base);
    let mut out = IndexSet::new();
    let mut add = |raw: &str| {
        let v = decode_entities(raw.trim());
        if v.is_empty() || SKIP.is_match(&v) || v.starts_with('#') {
            return;
        }
        if let Ok(mut u) = root.join(&v) {
            if u.scheme() == "http" || u.scheme() == "https" {
                u.set_fragment(None);
                out.insert(u.to_string());
            }
        }
    };
    for m in LINK.captures_iter(html) {
        add(m.get(1).or(m.get(2)).or(m.get(3)).map_or("", |g| g.as_str()));
    }
    for m in SRCSET.captures_iter(html) {
        for part in m.get(1).or(m.get(2)).map_or("", |g| g.as_str()).split(',') {
            add(part.split_whitespace().next().unwrap_or(""));
        }
    }
    out.into_iter().collect()
}

#[derive(Serialize, Clone, Debug)]
pub struct Found {
    pub url: String,
    pub name: String,
    pub ext: String,
    pub page: String,
}

#[derive(Serialize, Debug)]
pub struct Grabbed {
    pub files: Vec<Found>,
    pub pages: usize,
}

pub struct GrabOpts<'a> {
    pub depth: u32,
    pub exts: Vec<String>,
    pub same_site: bool,
    pub max_pages: usize,
    pub cancel: CancellationToken,
    pub on_page: &'a (dyn Fn(&str, usize) + Send + Sync),
}

pub async fn grab<F, Fut>(start: &str, fetch: F, o: GrabOpts<'_>) -> Result<Grabbed, String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Page, crate::http::HttpError>>,
{
    let want: HashSet<String> = o.exts.iter().map(|e| e.to_lowercase()).collect();
    let start_host = Url::parse(start).map_err(|e| e.to_string())?.host_str().unwrap_or("").to_string();
    let mut seen: HashSet<String> = HashSet::from([start.to_string()]);
    let mut files: IndexMap<String, Found> = IndexMap::new();
    let mut level = vec![start.to_string()];
    let mut pages = 0;
    for d in 0..=o.depth {
        if level.is_empty() {
            break;
        }
        let mut next = vec![];
        for url in &level {
            if o.cancel.is_cancelled() || pages >= o.max_pages {
                break;
            }
            let Ok(page) = fetch(url.clone()).await else { continue };
            pages += 1;
            let Some(text) = page.text.filter(|_| page.content_type.to_lowercase().contains("html")) else { continue };
            for link in extract_links(&text, &page.url) {
                let Ok(u) = Url::parse(&link) else { continue };
                let ext = ext_of(&decode(u.path()).unwrap_or_else(|| u.path().to_string()));
                if !ext.is_empty() && want.contains(&ext) {
                    files.entry(link.clone()).or_insert_with(|| {
                        let last = u.path().rsplit('/').next().unwrap_or("");
                        let name = if last.is_empty() { u.host_str().unwrap_or("").to_string() } else { decode(last).unwrap_or_else(|| last.to_string()) };
                        Found { url: link.clone(), name, ext, page: url.clone() }
                    });
                } else if d < o.depth && !seen.contains(&link) && (!o.same_site || u.host_str() == Some(&start_host)) && (ext.is_empty() || PAGE_EXT.is_match(&ext)) {
                    seen.insert(link.clone());
                    next.push(link);
                }
            }
            (o.on_page)(url, files.len());
        }
        level = next;
    }
    Ok(Grabbed { files: files.into_values().collect(), pages })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        let html = r#"<a href="a.zip">a</a> <a href='b.mp3'>b</a> <img src="/site/pic.png" srcset="x.png 1x, y.png 2x"> <a href="mailto:x@y">m</a> <a href="a.zip#again">dup</a> <a href="?a=1&amp;b=2">q</a>"#;
        let l = extract_links(html, "http://h/site/index.html");
        assert_eq!(l, ["http://h/site/a.zip", "http://h/site/b.mp3", "http://h/site/pic.png", "http://h/site/index.html?a=1&b=2", "http://h/site/x.png", "http://h/site/y.png"]);
    }
}
