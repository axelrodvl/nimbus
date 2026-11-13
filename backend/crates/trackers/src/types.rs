use async_trait::async_trait;
use nimbus_core::model::{InfoHash, TorrentSource};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchQuery {
    /// Уже собранная строка, например "Radiohead OK Computer".
    pub text: String,
    /// Для провайдеров со структурным поиском (Torznab `t=music`).
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<i32>,
    /// «Широкий» запрос (только исполнитель): стоит слать лишь провайдерам с хорошим поиском.
    pub broad: bool,
}

impl SearchQuery {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Self::default()
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct TorrentCandidate {
    pub source: TorrentSource,
    pub source_topic_id: Option<String>,
    pub title: String,
    /// `None` — если нужен отдельный шаг (`resolve`).
    pub info_hash: Option<InfoHash>,
    pub magnet: Option<String>,
    /// Ссылка на `.torrent`, из которой `resolve` может получить info-hash.
    pub download_url: Option<String>,
    pub size_bytes: Option<u64>,
    pub seeders: Option<u32>,
    pub leechers: Option<u32>,
    pub category: Option<String>,
    pub files_count: Option<u32>,
    /// Готовый `.torrent`, если провайдер его уже скачал (Torznab при `resolve`): по нему список
    /// файлов известен без сети. Не больше `MAX_TORRENT_FILE_BYTES`.
    pub torrent_file: Option<Vec<u8>>,
}

// Содержимое `.torrent` в логи не попадает: только размер.
impl std::fmt::Debug for TorrentCandidate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TorrentCandidate")
            .field("source", &self.source)
            .field("source_topic_id", &self.source_topic_id)
            .field("title", &self.title)
            .field("info_hash", &self.info_hash)
            .field("magnet", &self.magnet)
            .field("download_url", &self.download_url)
            .field("size_bytes", &self.size_bytes)
            .field("seeders", &self.seeders)
            .field("leechers", &self.leechers)
            .field("category", &self.category)
            .field("files_count", &self.files_count)
            .field(
                "torrent_file_len",
                &self.torrent_file.as_ref().map(Vec::len),
            )
            .finish()
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ProviderError {
    #[error("network error: {0}")]
    Network(String),
    #[error("blocked: {0}")]
    Blocked(String),
    #[error("auth error: {0}")]
    Auth(String),
    #[error("parse error: {0}")]
    Parse(String),
    #[error("rate limited")]
    RateLimited,
    #[error("provider timed out")]
    Timeout,
    /// Предохранитель разомкнут: провайдер недавно подряд отказывал, запрос не отправлялся.
    #[error("provider is temporarily disabled after repeated failures")]
    CircuitOpen,
}

impl From<reqwest::Error> for ProviderError {
    fn from(e: reqwest::Error) -> Self {
        ProviderError::Network(e.without_url().to_string())
    }
}

/// Проверяет HTTP-статус и переводит типичные отказы в `ProviderError`.
pub(crate) fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, ProviderError> {
    use reqwest::StatusCode as S;
    match resp.status() {
        s if s.is_success() => Ok(resp),
        S::TOO_MANY_REQUESTS => Err(ProviderError::RateLimited),
        S::UNAUTHORIZED | S::FORBIDDEN => {
            Err(ProviderError::Auth(format!("HTTP {}", resp.status())))
        }
        s if s.is_server_error() => Err(ProviderError::Blocked(format!("HTTP {s}"))),
        s => Err(ProviderError::Network(format!("HTTP {s}"))),
    }
}

#[async_trait]
pub trait TorrentProvider: Send + Sync {
    fn source(&self) -> TorrentSource;
    async fn search(&self, q: &SearchQuery) -> Result<Vec<TorrentCandidate>, ProviderError>;
    /// Дозаполнить info_hash/magnet, если `search` их не вернул. По умолчанию — no-op.
    async fn resolve(&self, c: TorrentCandidate) -> Result<TorrentCandidate, ProviderError> {
        Ok(c)
    }
}
