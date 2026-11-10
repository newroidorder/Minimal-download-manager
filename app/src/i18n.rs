//! Interface language: English or Brazilian Portuguese ("auto" follows Windows).

use serde_json::{Map, Value};
use std::sync::LazyLock;

static EN: LazyLock<Map<String, Value>> = LazyLock::new(|| serde_json::from_str(include_str!("../locales/en.json")).expect("en.json"));
static PT: LazyLock<Map<String, Value>> = LazyLock::new(|| serde_json::from_str(include_str!("../locales/pt-BR.json")).expect("pt-BR.json"));

pub fn resolve(setting: &str) -> String {
    if setting == "en" || setting == "pt-BR" {
        return setting.to_string();
    }
    let pt = sys_locale::get_locales().any(|l| l.to_lowercase().starts_with("pt"));
    if pt { "pt-BR" } else { "en" }.to_string()
}

pub fn dict(lang: &str) -> Map<String, Value> {
    let mut d = EN.clone();
    if lang == "pt-BR" {
        d.extend(PT.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    d
}

/// t("notify.quota", &[("time", "10:00")])
pub fn t(lang: &str, key: &str, vars: &[(&str, &str)]) -> String {
    let d = if lang == "pt-BR" { &*PT } else { &*EN };
    let mut s = d.get(key).or_else(|| EN.get(key)).and_then(Value::as_str).unwrap_or(key).to_string();
    for (k, v) in vars {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}
