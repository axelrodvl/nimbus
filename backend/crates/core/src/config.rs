use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("invalid value for {name}: {value:?} ({reason})")]
    Invalid {
        name: &'static str,
        value: String,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub database_url: String,
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub mb_user_agent: String,
    pub cors_origin: String,
    pub tpb_enabled: bool,
    pub torznab_url: Option<String>,
    pub torznab_api_key: Option<String>,
    pub rutracker_username: Option<String>,
    pub rutracker_password: Option<String>,
    pub rutracker_cookie: Option<String>,
    pub rutracker_proxy: Option<String>,
    pub cache_limit_gb: u64,
    pub seeding: bool,
    /// NIMBUS_SEED_RATIO: лимит раздачи (по умолчанию 1.0; `0`/`none` — без лимита).
    pub seed_ratio: Option<f64>,
    pub api_token: Option<String>,
    /// NIMBUS_DEBUG: включает отладочные эндпоинты в release-сборке.
    pub debug: bool,
}

impl Config {
    /// Читает конфигурацию из переменных окружения процесса.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Читает конфигурацию из произвольного источника (для тестов).
    pub fn from_map(map: &HashMap<&str, &str>) -> Result<Self, ConfigError> {
        Self::from_lookup(|k| map.get(k).map(|v| v.to_string()))
    }

    fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        // Пустая строка = переменная не задана.
        let opt = |name: &str| {
            get(name)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let or = |name: &str, default: &str| opt(name).unwrap_or_else(|| default.to_string());

        let database_url = opt("DATABASE_URL").ok_or(ConfigError::Missing("DATABASE_URL"))?;
        let bind_raw = or("NIMBUS_BIND", "0.0.0.0:8080");
        let bind =
            bind_raw
                .parse()
                .map_err(|e: std::net::AddrParseError| ConfigError::Invalid {
                    name: "NIMBUS_BIND",
                    value: bind_raw.clone(),
                    reason: e.to_string(),
                })?;
        let cache_raw = or("NIMBUS_CACHE_LIMIT_GB", "50");
        let cache_limit_gb =
            cache_raw
                .parse()
                .map_err(|e: std::num::ParseIntError| ConfigError::Invalid {
                    name: "NIMBUS_CACHE_LIMIT_GB",
                    value: cache_raw.clone(),
                    reason: e.to_string(),
                })?;
        let parse_bool = |name: &'static str, default: bool| -> Result<bool, ConfigError> {
            match opt(name).map(|v| v.to_ascii_lowercase()).as_deref() {
                None => Ok(default),
                Some("true" | "1" | "yes" | "on") => Ok(true),
                Some("false" | "0" | "no" | "off") => Ok(false),
                Some(other) => Err(ConfigError::Invalid {
                    name,
                    value: other.to_string(),
                    reason: "expected true/false".into(),
                }),
            }
        };

        let seed_ratio = match opt("NIMBUS_SEED_RATIO").as_deref() {
            None => Some(1.0),
            Some("none" | "0") => None,
            Some(v) => Some(
                v.parse::<f64>()
                    .ok()
                    .filter(|r| r.is_finite() && *r > 0.0)
                    .ok_or_else(|| ConfigError::Invalid {
                        name: "NIMBUS_SEED_RATIO",
                        value: v.to_string(),
                        reason: "expected a positive number, 0 or none".into(),
                    })?,
            ),
        };

        Ok(Self {
            database_url,
            bind,
            data_dir: PathBuf::from(or("NIMBUS_DATA_DIR", "./data")),
            mb_user_agent: or(
                "NIMBUS_MB_USER_AGENT",
                "Nimbus/0.1 ( https://github.com/your/nimbus )",
            ),
            cors_origin: or("NIMBUS_CORS_ORIGIN", "http://localhost:3000"),
            tpb_enabled: parse_bool("NIMBUS_TPB_ENABLED", true)?,
            torznab_url: opt("NIMBUS_TORZNAB_URL"),
            torznab_api_key: opt("NIMBUS_TORZNAB_API_KEY"),
            rutracker_username: opt("NIMBUS_RUTRACKER_USERNAME"),
            rutracker_password: opt("NIMBUS_RUTRACKER_PASSWORD"),
            rutracker_cookie: opt("NIMBUS_RUTRACKER_COOKIE"),
            rutracker_proxy: opt("NIMBUS_RUTRACKER_PROXY"),
            cache_limit_gb,
            seeding: parse_bool("NIMBUS_SEEDING", true)?,
            seed_ratio,
            api_token: opt("NIMBUS_API_TOKEN"),
            debug: parse_bool("NIMBUS_DEBUG", false)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> HashMap<&'static str, &'static str> {
        HashMap::from([("DATABASE_URL", "postgres://u:p@localhost/db")])
    }

    #[test]
    fn defaults() {
        let c = Config::from_map(&base()).unwrap();
        assert_eq!(c.bind, "0.0.0.0:8080".parse().unwrap());
        assert_eq!(c.data_dir, PathBuf::from("./data"));
        assert_eq!(c.cors_origin, "http://localhost:3000");
        assert!(c.tpb_enabled);
        assert!(c.seeding);
        assert_eq!(c.seed_ratio, Some(1.0));
        assert!(!c.debug);
        assert_eq!(c.cache_limit_gb, 50);
        assert!(c.torznab_url.is_none() && c.api_token.is_none());
    }

    #[test]
    fn empty_strings_are_none_or_default() {
        let mut m = base();
        m.insert("NIMBUS_TORZNAB_URL", "");
        m.insert("NIMBUS_RUTRACKER_COOKIE", "  ");
        m.insert("NIMBUS_API_TOKEN", "");
        m.insert("NIMBUS_BIND", "");
        let c = Config::from_map(&m).unwrap();
        assert!(c.torznab_url.is_none());
        assert!(c.rutracker_cookie.is_none());
        assert!(c.api_token.is_none());
        assert_eq!(c.bind.port(), 8080);
    }

    #[test]
    fn overrides() {
        let mut m = base();
        m.insert("NIMBUS_BIND", "127.0.0.1:9000");
        m.insert("NIMBUS_TPB_ENABLED", "false");
        m.insert("NIMBUS_SEEDING", "true");
        m.insert("NIMBUS_CACHE_LIMIT_GB", "7");
        m.insert("NIMBUS_API_TOKEN", "secret");
        let c = Config::from_map(&m).unwrap();
        assert_eq!(c.bind.port(), 9000);
        assert!(!c.tpb_enabled && c.seeding);
        assert_eq!(c.cache_limit_gb, 7);
        assert_eq!(c.api_token.as_deref(), Some("secret"));
    }

    #[test]
    fn missing_database_url_and_bad_values() {
        assert!(matches!(
            Config::from_map(&HashMap::new()),
            Err(ConfigError::Missing("DATABASE_URL"))
        ));
        let mut m = base();
        m.insert("NIMBUS_BIND", "nonsense");
        assert!(matches!(
            Config::from_map(&m),
            Err(ConfigError::Invalid {
                name: "NIMBUS_BIND",
                ..
            })
        ));
        let mut m = base();
        m.insert("NIMBUS_SEEDING", "maybe");
        assert!(Config::from_map(&m).is_err());
    }
}
