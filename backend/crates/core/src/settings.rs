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
    pub performance: PerformanceSettings,
    pub musicbrainz: MusicbrainzSettings,
}

/// Адрес и лимиты MusicBrainz. Применяются на лету (`MbClient::reconfigure`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MusicbrainzSettings {
    /// База Web Service v2: `http(s)://…/`, оканчивается на `/`.
    pub base_url: String,
    /// Запросов в секунду (0 — без ограничения темпа). Публичному серверу — не больше 1.
    pub rate_per_sec: f64,
    /// Размер «ведра»: сколько запросов подряд проходят без ожидания.
    pub burst: u8,
    /// Одновременных HTTP-запросов.
    pub max_concurrent: u8,
}

/// Адрес публичного MusicBrainz.
pub const PUBLIC_MB_BASE: &str = "https://musicbrainz.org/ws/2/";

impl Default for MusicbrainzSettings {
    fn default() -> Self {
        Self {
            base_url: PUBLIC_MB_BASE.into(),
            rate_per_sec: 1.0,
            burst: 3,
            max_concurrent: 2,
        }
    }
}

impl MusicbrainzSettings {
    /// Указывает ли `base_url` на публичный `musicbrainz.org` (его лимит — 1 запрос/с с IP).
    pub fn is_public(&self) -> bool {
        host_of(&self.base_url)
            .is_some_and(|h| h == "musicbrainz.org" || h.ends_with(".musicbrainz.org"))
    }

    /// Значения, которые реально применяются. Для своего зеркала, если пользователь не менял
    /// остальные поля (они равны значениям по умолчанию), лимит снимается и параллелизм — 8:
    /// публичные правила на частное зеркало не распространяются.
    pub fn effective(&self) -> Self {
        let d = Self::default();
        let untouched = self.rate_per_sec == d.rate_per_sec
            && self.burst == d.burst
            && self.max_concurrent == d.max_concurrent;
        if !self.is_public() && untouched {
            return Self {
                rate_per_sec: 0.0,
                max_concurrent: 8,
                ..self.clone()
            };
        }
        self.clone()
    }

    fn validate(&self) -> Result<(), String> {
        let host = host_of(&self.base_url);
        if host.is_none() || !self.base_url.ends_with('/') {
            return Err("musicbrainz.base_url must be an http(s) URL ending with \"/\"".into());
        }
        if !(self.rate_per_sec == 0.0 || (0.1..=100.0).contains(&self.rate_per_sec)) {
            return Err("musicbrainz.rate_per_sec must be 0 or between 0.1 and 100".into());
        }
        if !(1..=20).contains(&self.burst) {
            return Err("musicbrainz.burst must be between 1 and 20".into());
        }
        if !(1..=32).contains(&self.max_concurrent) {
            return Err("musicbrainz.max_concurrent must be between 1 and 32".into());
        }
        Ok(())
    }
}

/// Хост из `http(s)://host[:port]/…`; `None`, если схема другая или хоста нет.
fn host_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next()?
    } else {
        authority.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Параллелизм фоновых воркеров. Читается при старте: изменение требует перезапуска.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PerformanceSettings {
    /// Одновременных задач поиска (`discover_*`).
    pub discover_workers: u8,
    /// Одновременных проверок раздач (`verify_torrent`, `process_cue`).
    pub verify_workers: u8,
    /// Одновременных импортов дискографий (`import_artist`).
    pub import_workers: u8,
    /// Одновременных сетевых запросов метаданных торрента (DHT + пиры).
    pub metadata_concurrency: u8,
    /// Сколько секунд ждать метаданные торрента по magnet.
    pub metadata_timeout_secs: u16,
    /// Сколько торрентов менеджер закреплений качает одновременно (1..=32).
    pub download_concurrency: u8,
}

impl Default for PerformanceSettings {
    fn default() -> Self {
        Self {
            discover_workers: 8,
            verify_workers: 16,
            import_workers: 2,
            metadata_concurrency: 16,
            metadata_timeout_secs: 30,
            download_concurrency: 4,
        }
    }
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
    /// User-Agent запросов к RuTracker; должен совпадать с браузером, в котором получен `cf_clearance`.
    pub user_agent: Option<String>,
    /// Дополнительные заголовки: по одному `Name: value` в строке (см. `parse_extra_headers`).
    pub headers: Option<String>,
    /// Адрес FlareSolverr (`http://flaresolverr:8191`): проходит Cloudflare-челлендж вместо браузера.
    pub flaresolverr_url: Option<String>,
    pub music_forums_regex: Option<String>,
}

/// Заголовки, которые нельзя задавать вручную: их выставляет клиент или для них есть отдельное поле.
const FORBIDDEN_HEADERS: &[&str] = &[
    "cookie",
    "host",
    "content-length",
    "content-type",
    "transfer-encoding",
    "connection",
    "user-agent",
];

/// Разбирает многострочный список заголовков `Name: value` (пустые строки и псевдозаголовки HTTP/2 вида
/// `:authority: …` пропускаются). `Cookie` и `User-Agent` здесь запрещены — для них есть свои поля,
/// а значение cookie — секрет и не должно лежать в открытом тексте настроек.
pub fn parse_extra_headers(text: &str) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if line.starts_with(':') {
            continue;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| format!("header line \"{line}\" must look like \"Name: value\""))?;
        let (name, value) = (name.trim(), value.trim());
        let token = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c);
        if name.is_empty() || !name.chars().all(token) {
            return Err(format!("invalid header name \"{name}\""));
        }
        if FORBIDDEN_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(format!(
                "header \"{name}\" is set by its own field (cookie, user agent) or by Nimbus and cannot be overridden here"
            ));
        }
        if value.chars().any(|c| c.is_control() && c != '\t') {
            return Err(format!("invalid value of header \"{name}\""));
        }
        out.push((name.to_string(), value.to_string()));
    }
    if out.len() > 50 {
        return Err("too many extra headers (at most 50)".into());
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchSettings {
    /// Сколько лучших раздач сохраняем и проверяем.
    pub max_candidates: u8,
    /// Порядок предпочтения форматов: `flac, alac, mp3_320, mp3_v0, aac, ape_wv, mp3_other`.
    pub format_prefs: Vec<String>,
    /// Release group'ы с такими типами (primary `EP` или secondary) не импортируются вместе с артистом.
    pub skip_secondary_types: Vec<String>,
    /// Автоматически повторять поиск для альбомов, которые не нашлись (с растущими интервалами).
    pub auto_retry: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MatchingSettings {
    /// Порог уверенного совпадения файла с треком.
    pub accept: f64,
    /// Порог совпадения «с подтверждением».
    pub confirm: f64,
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
    pub seed_ratio: Option<f64>,
    /// `off` | `added`: при `added` всё добавляемое в библиотеку сразу закрепляется (скачивается на сервер).
    pub auto_download: String,
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
            skip_secondary_types: [
                "EP",
                "Compilation",
                "Live",
                "Remix",
                "DJ-mix",
                "Demo",
                "Soundtrack",
                "Mixtape/Street",
                "Spokenword",
                "Interview",
                "Audiobook",
                "Audio drama",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            auto_retry: true,
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
            seeding: true,
            seed_ratio: Some(1.0),
            auto_download: "off".into(),
        }
    }
}

impl Settings {
    /// Значения по умолчанию из окружения (`NIMBUS_*`).
    pub fn from_config(c: &Config) -> Self {
        let rutracker = (c.rutracker_username.is_some()
            || c.rutracker_password.is_some()
            || c.rutracker_cookie.is_some()
            || c.rutracker_proxy.is_some()
            || c.flaresolverr_url.is_some())
        .then(|| RutrackerSettings {
            username: c.rutracker_username.clone(),
            password: c.rutracker_password.clone(),
            cookie: c.rutracker_cookie.clone(),
            proxy: c.rutracker_proxy.clone(),
            user_agent: None,
            headers: None,
            flaresolverr_url: c.flaresolverr_url.clone(),
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
                seed_ratio: c.seed_ratio,
                ..StorageSettings::default()
            },
            ..Self::default()
        }
    }

    /// Поля, у которых пустое значение означает «как в окружении»: сохранённые настройки
    /// (в том числе `null`, записанный до появления переменной) не отключают их. Сейчас это адрес
    /// FlareSolverr: без него RuTracker упирается в Cloudflare.
    pub fn with_env_fallbacks(mut self, env: &Settings) -> Self {
        let env_solver = env
            .providers
            .rutracker
            .as_ref()
            .and_then(|r| r.flaresolverr_url.clone())
            .filter(|u| !u.trim().is_empty());
        if let (Some(r), Some(url)) = (self.providers.rutracker.as_mut(), env_solver) {
            if r.flaresolverr_url
                .as_deref()
                .is_none_or(|u| u.trim().is_empty())
            {
                r.flaresolverr_url = Some(url);
            }
        }
        self
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
        let p = &self.performance;
        for (name, v) in [
            ("discover_workers", p.discover_workers),
            ("verify_workers", p.verify_workers),
            ("import_workers", p.import_workers),
            ("metadata_concurrency", p.metadata_concurrency),
        ] {
            if !(1..=64).contains(&v) {
                return Err(format!("performance.{name} must be between 1 and 64"));
            }
        }
        if !(5..=300).contains(&p.metadata_timeout_secs) {
            return Err("performance.metadata_timeout_secs must be between 5 and 300".into());
        }
        if !(1..=32).contains(&p.download_concurrency) {
            return Err("performance.download_concurrency must be between 1 and 32".into());
        }
        if !["off", "added"].contains(&self.storage.auto_download.as_str()) {
            return Err("storage.auto_download must be \"off\" or \"added\"".into());
        }
        self.musicbrainz.validate()?;
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
        if let Some(r) = &self.providers.rutracker {
            if let Some(ua) = r.user_agent.as_deref() {
                if ua.len() > 500 || ua.chars().any(char::is_control) {
                    return Err("providers.rutracker.user_agent is invalid".into());
                }
            }
            if let Some(h) = r.headers.as_deref() {
                if h.len() > 8192 {
                    return Err("providers.rutracker.headers is too long".into());
                }
                parse_extra_headers(h).map_err(|e| format!("providers.rutracker.headers: {e}"))?;
            }
            if let Some(u) = r.flaresolverr_url.as_deref().map(str::trim) {
                let lower = u.to_ascii_lowercase();
                let valid = u.is_empty()
                    || (u.len() <= 500
                        && !u.chars().any(char::is_whitespace)
                        && (lower.starts_with("http://") || lower.starts_with("https://")));
                if !valid {
                    return Err(
                        "providers.rutracker.flaresolverr_url must be an http(s) URL".into(),
                    );
                }
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
    fn extra_headers_parse_and_reject_reserved() {
        let h = parse_extra_headers(
            ":authority: rutracker.org\n\nAccept-Language: ru,en;q=0.8\n sec-ch-ua : \"Chromium\";v=\"130\" \n",
        )
        .unwrap();
        assert_eq!(
            h,
            [
                ("Accept-Language".to_string(), "ru,en;q=0.8".to_string()),
                (
                    "sec-ch-ua".to_string(),
                    "\"Chromium\";v=\"130\"".to_string()
                ),
            ]
        );
        for bad in [
            "Cookie: a=b",
            "user-agent: x",
            "Host: x",
            "no colon here",
            "bad name: v",
        ] {
            assert!(parse_extra_headers(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn validate_checks_flaresolverr_url() {
        let mut s = Settings::default();
        for (url, ok) in [
            ("http://flaresolverr:8191", true),
            ("https://fs.example/v1", true),
            ("", true),
            ("flaresolverr:8191", false),
            ("http://a b", false),
        ] {
            s.providers.rutracker = Some(RutrackerSettings {
                flaresolverr_url: Some(url.into()),
                ..Default::default()
            });
            assert_eq!(s.validate().is_ok(), ok, "{url}");
        }
    }

    #[test]
    fn validate_rejects_bad_rutracker_headers_and_user_agent() {
        let mut s = Settings::default();
        s.providers.rutracker = Some(RutrackerSettings {
            headers: Some("Cookie: bb_session=1".into()),
            ..Default::default()
        });
        assert!(s
            .validate()
            .unwrap_err()
            .contains("providers.rutracker.headers"));
        s.providers.rutracker = Some(RutrackerSettings {
            user_agent: Some("a\nb".into()),
            ..Default::default()
        });
        assert!(s.validate().unwrap_err().contains("user_agent"));
        s.providers.rutracker = Some(RutrackerSettings {
            user_agent: Some("Mozilla/5.0".into()),
            headers: Some("Accept-Language: ru".into()),
            ..Default::default()
        });
        assert!(s.validate().is_ok());
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
    fn performance_defaults_and_bounds() {
        let p = Settings::default().performance;
        assert_eq!(
            (p.discover_workers, p.verify_workers, p.import_workers),
            (8, 16, 2)
        );
        assert_eq!((p.metadata_concurrency, p.metadata_timeout_secs), (16, 30));
        for bad in [0u8, 65] {
            let mut s = Settings::default();
            s.performance.import_workers = bad;
            assert!(s.validate().is_err(), "{bad}");
            let mut s = Settings::default();
            s.performance.metadata_concurrency = bad;
            assert!(s.validate().is_err(), "{bad}");
        }
        for bad in [0u16, 4, 301, 5000] {
            let mut s = Settings::default();
            s.performance.metadata_timeout_secs = bad;
            assert!(s.validate().is_err(), "{bad}");
        }
        for ok in [5u16, 30, 300] {
            let mut s = Settings::default();
            s.performance.metadata_timeout_secs = ok;
            assert!(s.validate().is_ok(), "{ok}");
        }
        let s = Settings {
            performance: PerformanceSettings {
                discover_workers: 1,
                verify_workers: 64,
                import_workers: 64,
                metadata_concurrency: 64,
                metadata_timeout_secs: 300,
                download_concurrency: 32,
            },
            ..Settings::default()
        };
        assert!(s.validate().is_ok());
    }

    #[test]
    fn download_concurrency_and_auto_download_are_validated() {
        let d = Settings::default();
        assert_eq!(d.performance.download_concurrency, 4);
        assert_eq!(d.storage.auto_download, "off");
        for bad in [0u8, 33] {
            let mut s = Settings::default();
            s.performance.download_concurrency = bad;
            assert!(s.validate().is_err(), "{bad}");
        }
        for ok in [1u8, 32] {
            let mut s = Settings::default();
            s.performance.download_concurrency = ok;
            assert!(s.validate().is_ok(), "{ok}");
        }
        let mut s = Settings::default();
        s.storage.auto_download = "added".into();
        assert!(s.validate().is_ok());
        s.storage.auto_download = "always".into();
        assert!(s.validate().is_err());
    }

    #[test]
    fn performance_can_be_patched_partially() {
        let m = merge_patch(
            &Settings::default(),
            &json!({"performance": {"verify_workers": 4}}),
        )
        .unwrap();
        assert_eq!(m.performance.verify_workers, 4);
        assert_eq!(m.performance.discover_workers, 8);
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
        assert!(m.storage.seeding);
        assert_eq!(m.storage.seed_ratio, Some(1.0));
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

        // Один адрес FlareSolverr из окружения: учётные данные потом задаются в интерфейсе.
        let c = Config::from_map(&std::collections::HashMap::from([
            ("DATABASE_URL", "postgres://x"),
            ("NIMBUS_FLARESOLVERR_URL", "http://flaresolverr:8191"),
        ]))
        .unwrap();
        let r = Settings::from_config(&c).providers.rutracker.unwrap();
        assert_eq!(
            r.flaresolverr_url.as_deref(),
            Some("http://flaresolverr:8191")
        );
        assert!(r.username.is_none() && r.cookie.is_none());
    }

    #[test]
    fn empty_flaresolverr_url_falls_back_to_env() {
        let mut env = Settings::default();
        env.providers.rutracker = Some(RutrackerSettings {
            flaresolverr_url: Some("http://flaresolverr:8191".into()),
            ..Default::default()
        });
        let mut saved = Settings::default();
        // Нет RuTracker вовсе — ничего не создаём.
        assert!(saved
            .clone()
            .with_env_fallbacks(&env)
            .providers
            .rutracker
            .is_none());
        for stored in [None, Some(String::new())] {
            saved.providers.rutracker = Some(RutrackerSettings {
                username: Some("u".into()),
                flaresolverr_url: stored,
                ..Default::default()
            });
            let r = saved
                .clone()
                .with_env_fallbacks(&env)
                .providers
                .rutracker
                .unwrap();
            assert_eq!(
                r.flaresolverr_url.as_deref(),
                Some("http://flaresolverr:8191")
            );
            assert_eq!(r.username.as_deref(), Some("u"));
        }
        // Свой адрес не перетирается.
        saved.providers.rutracker = Some(RutrackerSettings {
            flaresolverr_url: Some("http://byparr:8191".into()),
            ..Default::default()
        });
        let r = saved.with_env_fallbacks(&env).providers.rutracker.unwrap();
        assert_eq!(r.flaresolverr_url.as_deref(), Some("http://byparr:8191"));
    }

    fn mb(f: impl FnOnce(&mut MusicbrainzSettings)) -> MusicbrainzSettings {
        let mut m = MusicbrainzSettings::default();
        f(&mut m);
        m
    }

    #[test]
    fn musicbrainz_defaults_and_validation() {
        let d = MusicbrainzSettings::default();
        assert_eq!(
            (
                d.base_url.as_str(),
                d.rate_per_sec,
                d.burst,
                d.max_concurrent
            ),
            ("https://musicbrainz.org/ws/2/", 1.0, 3, 2)
        );
        assert!(Settings::default().validate().is_ok());
        let bad = [
            mb(|m| m.base_url = "ftp://x/".into()),
            mb(|m| m.base_url = "http://mirror".into()),
            mb(|m| m.base_url = "https:///".into()),
            mb(|m| m.base_url = "not a url/".into()),
            mb(|m| m.rate_per_sec = 0.05),
            mb(|m| m.rate_per_sec = 101.0),
            mb(|m| m.rate_per_sec = -1.0),
            mb(|m| m.burst = 0),
            mb(|m| m.burst = 21),
            mb(|m| m.max_concurrent = 0),
            mb(|m| m.max_concurrent = 33),
        ];
        for b in bad {
            let s = Settings {
                musicbrainz: b.clone(),
                ..Settings::default()
            };
            assert!(s.validate().is_err(), "{b:?}");
        }
        let ok = [
            mb(|m| m.rate_per_sec = 0.0),
            mb(|m| m.rate_per_sec = 0.1),
            mb(|m| m.rate_per_sec = 100.0),
            mb(|m| m.burst = 20),
            mb(|m| m.max_concurrent = 32),
            mb(|m| m.base_url = "http://localhost:5000/ws/2/".into()),
        ];
        for o in ok {
            let s = Settings {
                musicbrainz: o.clone(),
                ..Settings::default()
            };
            assert!(s.validate().is_ok(), "{o:?}");
        }
    }

    #[test]
    fn musicbrainz_effective_uses_mirror_profile_only_when_untouched() {
        let public = MusicbrainzSettings::default();
        assert!(public.is_public());
        assert_eq!(public.effective(), public);

        let mirror = mb(|m| m.base_url = "http://mb.lan:5000/ws/2/".into());
        assert!(!mirror.is_public());
        let e = mirror.effective();
        assert_eq!((e.rate_per_sec, e.burst, e.max_concurrent), (0.0, 3, 8));
        assert_eq!(e.base_url, mirror.base_url);

        // Явно заданные значения не переопределяются.
        let tuned = mb(|m| {
            m.base_url = "http://mb.lan/ws/2/".into();
            m.rate_per_sec = 5.0;
        });
        assert_eq!(tuned.effective(), tuned);

        // Поддомен musicbrainz.org — тоже публичный сервер; обманный хост — нет.
        assert!(mb(|m| m.base_url = "https://beta.musicbrainz.org/ws/2/".into()).is_public());
        assert!(
            !mb(|m| m.base_url = "https://musicbrainz.org.evil.example/ws/2/".into()).is_public()
        );
        assert!(
            !mb(|m| m.base_url = "https://user@evil.example/musicbrainz.org/".into()).is_public()
        );
        assert!(!mb(|m| m.base_url = "garbage".into()).is_public());
    }

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("http://[::1]:5000/x").as_deref(), Some("::1"));
        assert_eq!(
            host_of("https://Host.Example:8080/").as_deref(),
            Some("host.example")
        );
        assert_eq!(host_of("https://u:p@h/").as_deref(), Some("h"));
        assert_eq!(host_of("https://h?x#y").as_deref(), Some("h"));
        assert_eq!(host_of("file:///x"), None);
    }
}
