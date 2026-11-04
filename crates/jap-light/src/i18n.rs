//! Shared UI source keys; metadata, lyric content and stable IDs stay untouched.
use std::{cell::Cell, collections::BTreeMap, sync::OnceLock};
thread_local! {
    // Android's emulated-TLS expansion is linted as non-const by Clippy even
    // with this explicit const initializer.
    #[cfg_attr(target_os = "android", allow(clippy::missing_const_for_thread_local))]
    static ENGLISH: Cell<bool> = const { Cell::new(true) };
}
static MESSAGES: OnceLock<BTreeMap<String, String>> = OnceLock::new();
fn messages() -> &'static BTreeMap<String, String> {
    MESSAGES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../apps/desktop/src/shared/locales/en.json"
        ))
        .expect("valid bundled translation catalogue")
    })
}
pub fn resolve(preference: &str, system: &str) -> &'static str {
    let tag = if preference.is_empty() || preference == "system" {
        system
    } else {
        preference
    };
    let tag = tag.to_ascii_lowercase();
    if tag == "zh" || tag.starts_with("zh-") || tag.starts_with("zh_") {
        "zh-CN"
    } else {
        "en"
    }
}
pub fn configure(settings: &serde_json::Value) {
    static SYSTEM: OnceLock<String> = OnceLock::new();
    let system = settings["systemLocale"].as_str().unwrap_or_else(|| {
        SYSTEM.get_or_init(|| sys_locale::get_locale().unwrap_or_else(|| "en".into()))
    });
    ENGLISH.set(resolve(settings["language"].as_str().unwrap_or("system"), system) == "en");
}
pub fn tr(text: &str) -> &str {
    if ENGLISH.get() {
        messages().get(text).map(String::as_str).unwrap_or(text)
    } else {
        text
    }
}
pub fn tr_text(text: impl AsRef<str>) -> String {
    let text = text.as_ref();
    let exact = tr(text);
    if exact != text || !ENGLISH.get() {
        return exact.to_owned();
    }
    type Pattern = (regex::Regex, String, Vec<String>);
    static PATTERNS: OnceLock<Vec<Pattern>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        let slot = regex::Regex::new(r"\{\d+\}").unwrap();
        let mut entries: Vec<_> = messages()
            .iter()
            .filter(|(key, _)| slot.is_match(key))
            .collect();
        entries.sort_by_key(|(key, _)| std::cmp::Reverse(slot.replace_all(key, "").len()));
        entries
            .into_iter()
            .filter_map(|(key, value)| {
                let mut pattern = String::from("(?s)^");
                let mut start = 0;
                let mut slots = Vec::new();
                for m in slot.find_iter(key) {
                    pattern.push_str(&regex::escape(&key[start..m.start()]));
                    pattern.push_str("(.*?)");
                    start = m.end();
                    slots.push(m.as_str().to_owned());
                }
                pattern.push_str(&regex::escape(&key[start..]));
                pattern.push('$');
                regex::Regex::new(&pattern)
                    .ok()
                    .map(|r| (r, value.clone(), slots))
            })
            .collect()
    });
    static SLOT: OnceLock<regex::Regex> = OnceLock::new();
    let slot_regex = SLOT.get_or_init(|| regex::Regex::new(r"\{\d+\}").unwrap());
    for (regex, value, slots) in patterns {
        if let Some(captures) = regex.captures(text) {
            return slot_regex
                .replace_all(value, |m: &regex::Captures<'_>| {
                    slots
                        .iter()
                        .position(|slot| slot == &m[0])
                        .and_then(|index| captures.get(index + 1))
                        .map(|m| m.as_str())
                        .unwrap_or("")
                        .to_owned()
                })
                .into_owned();
        }
    }
    text.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fallback_and_parameters() {
        assert_eq!(resolve("system", "de-DE"), "en");
        assert_eq!(resolve("system", "zh-Hans-CN"), "zh-CN");
        configure(&serde_json::json!({"language":"en"}));
        assert_eq!(tr("播放"), "Play");
        assert_eq!(tr_text("已添加 12 首"), "Added 12 tracks");
        assert_eq!(tr_text("待播放 · 暂停"), "Up next · 暂停");
        configure(&serde_json::json!({"language":"zh-CN"}));
        assert_eq!(tr("播放"), "播放");
    }
}
