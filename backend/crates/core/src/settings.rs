//! Настройки приложения: значения по умолчанию берутся из `Config` (env), поверх них — запись в БД.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::Config;

/// Строка-маска, которой `GET /api/settings` заменяет заданные секреты.
pub const SECRET_MASK: &str = "••••";

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub providers: ProvidersSettings,
    pub search: SearchSettings,
    pub matching: MatchingSettings,
    pub playback: PlaybackSettings,
    pub storage: StorageSettings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProvidersSettings {
    pub tpb_enabled: bool,
    pub torznab: Option<TorznabSettings>,
    pub rutracker: Option<RutrackerSettings>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TorznabSettings {
    pub url: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RutrackerSettings {
    pub username: Option<String>,
    pub password: Option<String>,
    pub cookie: Option<String>,
    pub proxy: Option<String>,
    pub music_forums_regex: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchSettings {
    /// Сколько лучших раздач сохраняем и проверяем.
    pub max_candidates: u8,
    /// Порядок предпочтения форматов: `flac, alac, mp3_320, mp3_v0, aac, ape_wv, mp3_other`.
    pub format_prefs: Vec<String>,
    /// Release group'ы с такими secondary types не импортируются вместе с артистом.
    pub skip_secondary_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MatchingSettings {
    /// Порог уверенного совпадения файла с треком.
    pub accept: f32,
    /// Порог совпадения «с подтверждением».
    pub confirm: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PlaybackSettings {
    pub transcode_alac: bool,
    /// `opus` | `mp3` — кодек для lossy-источников при перекодировании.
    pub transcode_lossy_codec: String,
    pub prefetch_next: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StorageSettings {
    pub cache_limit_gb: u64,
    pub seeding: bool,
    pub seed_ratio: Option<f32>,
}

pub const FORMAT_KEYS: [&str; 7] = [
    "flac",
    "alac",
    "mp3_320",
    "mp3_v0",
    "aac",
    "ape_wv",
    "mp3_other",
];

impl Default for ProvidersSettings {
    fn default() -> Self {
        Self {
            tpb_enabled: true,
            torznab: None,
            rutracker: None,
        }
    }
}

impl Default for SearchSettings {
    fn default() -> Self {
        Self {
            max_candidates: 8,
            format_prefs: FORMAT_KEYS.iter().map(|s| s.to_string()).collect(),
            skip_secondary_types: ["Compilation", "Live", "Remix", "DJ-mix", "Demo"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
}

impl Default for MatchingSettings {
    fn default() -> Self {
        Self {
            accept: 0.80,
            confirm: 0.65,
        }
    }
}

impl Default for PlaybackSettings {
    fn default() -> Self {
        Self {
            transcode_alac: false,
            transcode_lossy_codec: "opus".into(),
            prefetch_next: true,
        }
    }
}

impl Default for StorageSettings {
    fn default() -> Self {
        Self {
            cache_limit_gb: 50,
            seeding: false,
            seed_ratio: None,
        }
    }
}

impl Settings {
    /// Значения по умолчанию из окружения (`NIMBUS_*`).
    pub fn from_config(c: &Config) -> Self {
        let rutracker = (c.rutracker_username.is_some()
            || c.rutracker_password.is_some()
            || c.rutracker_cookie.is_some()
            || c.rutracker_proxy.is_some())
        .then(|| RutrackerSettings {
            username: c.rutracker_username.clone(),
            password: c.rutracker_password.clone(),
            cookie: c.rutracker_cookie.clone(),
            proxy: c.rutracker_proxy.clone(),
            music_forums_regex: None,
        });
        Self {
            providers: ProvidersSettings {
                tpb_enabled: c.tpb_enabled,
                torznab: c.torznab_url.clone().map(|url| TorznabSettings {
                    url,
                    api_key: c.torznab_api_key.clone(),
                }),
                rutracker,
            },
            storage: StorageSettings {
                cache_limit_gb: c.cache_limit_gb,
                seeding: c.seeding,
                seed_ratio: None,
            },
            ..Self::default()
        }
    }

    pub fn cache_limit_bytes(&self) -> u64 {
        self.storage
            .cache_limit_gb
            .saturating_mul(1024 * 1024 * 1024)
    }

    /// Проверка значений после слияния.
    pub fn validate(&self) -> Result<(), String> {
        let m = &self.matching;
        if !(0.0..=1.0).contains(&m.accept) || !(0.0..=1.0).contains(&m.confirm) {
            return Err("matching thresholds must be between 0 and 1".into());
        }
        if m.confirm > m.accept {
            return Err("matching.confirm must not exceed matching.accept".into());
        }
        if !(1..=30).contains(&self.search.max_candidates) {
            return Err("search.max_candidates must be between 1 and 30".into());
        }
        for f in &self.search.format_prefs {
            if !FORMAT_KEYS.contains(&f.as_str()) {
                return Err(format!("unknown format {f:?}"));
            }
        }
        if !["opus", "mp3"].contains(&self.playback.transcode_lossy_codec.as_str()) {
            return Err("playback.transcode_lossy_codec must be \"opus\" or \"mp3\"".into());
        }
        if self.storage.cache_limit_gb == 0 {
            return Err("storage.cache_limit_gb must be at least 1".into());
        }
        if self.storage.seed_ratio.is_some_and(|r| r <= 0.0) {
            return Err("storage.seed_ratio must be positive".into());
        }
        if let Some(t) = &self.providers.torznab {
            if t.url.trim().is_empty() {
                return Err("providers.torznab.url must not be empty".into());
            }
        }
        if let Some(re) = self
            .providers
            .rutracker
            .as_ref()
            .and_then(|r| r.music_forums_regex.as_deref())
            .filter(|r| !r.is_empty())
        {
            if re.len() > 500 {
                return Err("providers.rutracker.music_forums_regex is too long".into());
            }
        }
        Ok(())
    }
}

/// Пути секретных полей в JSON настроек.
const SECRET_PATHS: [&[&str]; 3] = [
    &["providers", "torznab", "api_key"],
    &["providers", "rutracker", "password"],
    &["providers", "rutracker", "cookie"],
];

fn is_secret(path: &[&str]) -> bool {
    SECRET_PATHS.contains(&path)
}

/// Секреты заменены на маску (`SECRET_MASK`), если заданы; незаданные — `null`.
pub fn mask_secrets(settings: &Settings) -> Value {
    let mut v = serde_json::to_value(settings).expect("Settings serializes");
    for path in SECRET_PATHS {
        let pointer = format!("/{}", path.join("/"));
        if let Some(field) = v.pointer_mut(&pointer) {
            if field.as_str().is_some_and(|s| !s.is_empty()) {
                *field = Value::String(SECRET_MASK.into());
            }
        }
    }
    v
}

fn merge_into(target: &mut Value, patch: &Value, path: &mut Vec<String>) {
    match (target, patch) {
        (Value::Object(t), Value::Object(p)) => {
            for (k, pv) in p {
                path.push(k.clone());
                let refs: Vec<&str> = path.iter().map(String::as_str).collect();
                let secret_unchanged = is_secret(&refs)
                    && pv
                        .as_str()
                        .is_some_and(|s| s.is_empty() || s == SECRET_MASK);
                if !secret_unchanged {
                    match t.get_mut(k) {
                        Some(tv) if tv.is_object() && pv.is_object() => merge_into(tv, pv, path),
                        // Новый вложенный объект поверх `null`: сливаем с пустым, чтобы
                        // маска/пустой секрет не сохранялись как значение.
                        Some(tv) if tv.is_null() && pv.is_object() => {
                            *tv = Value::Object(Default::default());
                            merge_into(tv, pv, path);
                        }
                        _ => {
                            t.insert(k.clone(), pv.clone());
                        }
                    }
                }
                path.pop();
            }
        }
        (t, p) => *t = p.clone(),
    }
}

/// Сливает частичный JSON в текущие настройки: объекты — рекурсивно, массивы и скаляры заменяются,
/// `null` сбрасывает необязательное поле. Пустой секрет или маска не меняют сохранённое значение.
pub fn merge_patch(current: &Settings, patch: &Value) -> Result<Settings, String> {
    if !patch.is_object() {
        return Err("settings patch must be a JSON object".into());
    }
    let mut v = serde_json::to_value(current).expect("Settings serializes");
    merge_into(&mut v, patch, &mut Vec::new());
    let merged: Settings = serde_json::from_value(v).map_err(|e| e.to_string())?;
    merged.validate()?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn with_secrets() -> Settings {
        let mut s = Settings::default();
        s.providers.torznab = Some(TorznabSettings {
            url: "http://t".into(),
            api_key: Some("KEY".into()),
        });
        s.providers.rutracker = Some(RutrackerSettings {
            username: Some("u".into()),
            password: Some("pw".into()),
            cookie: Some("bb_session=1".into()),
            ..Default::default()
        });
        s
    }

    #[test]
    fn masks_set_secrets_only() {
        let v = mask_secrets(&with_secrets());
        assert_eq!(v["providers"]["torznab"]["api_key"], SECRET_MASK);
        assert_eq!(v["providers"]["rutracker"]["password"], SECRET_MASK);
        assert_eq!(v["providers"]["rutracker"]["cookie"], SECRET_MASK);
        assert_eq!(v["providers"]["rutracker"]["username"], "u");
        assert!(!v.to_string().contains("pw") && !v.to_string().contains("KEY"));
        let none = mask_secrets(&Settings::default());
        assert!(none["providers"]["torznab"].is_null());
    }

    #[test]
    fn merge_is_partial_and_keeps_untouched_sections() {
        let cur = with_secrets();
        let m = merge_patch(
            &cur,
            &json!({"storage": {"cache_limit_gb": 5}, "matching": {"accept": 0.9}}),
        )
        .unwrap();
        assert_eq!(m.storage.cache_limit_gb, 5);
        assert!(!m.storage.seeding);
        assert_eq!(m.matching.accept, 0.9);
        assert_eq!(m.matching.confirm, 0.65);
        assert_eq!(m.providers, cur.providers);
    }

    #[test]
    fn empty_or_masked_secret_does_not_overwrite() {
        let cur = with_secrets();
        let m = merge_patch(
            &cur,
            &json!({"providers": {"rutracker": {"username": "new", "password": "", "cookie": SECRET_MASK}, "torznab": {"api_key": ""}}}),
        )
        .unwrap();
        let r = m.providers.rutracker.unwrap();
        assert_eq!(r.username.as_deref(), Some("new"));
        assert_eq!(r.password.as_deref(), Some("pw"));
        assert_eq!(r.cookie.as_deref(), Some("bb_session=1"));
        assert_eq!(m.providers.torznab.unwrap().api_key.as_deref(), Some("KEY"));
    }

    #[test]
    fn real_secret_replaces_and_null_clears() {
        let cur = with_secrets();
        let m = merge_patch(&cur, &json!({"providers": {"rutracker": {"password": "fresh", "cookie": null}, "torznab": null}})).unwrap();
        let r = m.providers.rutracker.unwrap();
        assert_eq!(r.password.as_deref(), Some("fresh"));
        assert_eq!(r.cookie, None);
        assert!(m.providers.torznab.is_none());
    }

    #[test]
    fn creating_a_section_from_nothing_ignores_mask() {
        let m = merge_patch(
            &Settings::default(),
            &json!({"providers": {"torznab": {"url": "http://x", "api_key": SECRET_MASK}}}),
        )
        .unwrap();
        let t = m.providers.torznab.unwrap();
        assert_eq!((t.url.as_str(), t.api_key), ("http://x", None));
    }

    #[test]
    fn arrays_are_replaced_and_validation_rejects_nonsense() {
        let m = merge_patch(
            &Settings::default(),
            &json!({"search": {"format_prefs": ["mp3_320", "flac"]}}),
        )
        .unwrap();
        assert_eq!(m.search.format_prefs, ["mp3_320", "flac"]);
        for bad in [
            json!({"matching": {"accept": 0.5, "confirm": 0.7}}),
            json!({"search": {"max_candidates": 0}}),
            json!({"search": {"format_prefs": ["wat"]}}),
            json!({"playback": {"transcode_lossy_codec": "wma"}}),
            json!({"storage": {"cache_limit_gb": 0}}),
            json!({"storage": {"cache_limit_gb": "lots"}}),
        ] {
            assert!(merge_patch(&Settings::default(), &bad).is_err(), "{bad}");
        }
        assert!(merge_patch(&Settings::default(), &json!([1])).is_err());
    }

    #[test]
    fn defaults_come_from_config() {
        let c = Config::from_map(&std::collections::HashMap::from([
            ("DATABASE_URL", "postgres://x"),
            ("NIMBUS_CACHE_LIMIT_GB", "7"),
            ("NIMBUS_SEEDING", "true"),
            ("NIMBUS_TORZNAB_URL", "http://tz"),
            ("NIMBUS_RUTRACKER_COOKIE", "c"),
        ]))
        .unwrap();
        let s = Settings::from_config(&c);
        assert_eq!((s.storage.cache_limit_gb, s.storage.seeding), (7, true));
        assert_eq!(s.providers.torznab.unwrap().url, "http://tz");
        assert_eq!(s.providers.rutracker.unwrap().cookie.as_deref(), Some("c"));
    }
}
