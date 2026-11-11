pub type Result<T, E = MbError> = std::result::Result<T, E>;

/// Ошибка клиента. `Clone`, чтобы результат можно было разделить между ожидающими (single-flight).
#[derive(Debug, Clone, thiserror::Error)]
pub enum MbError {
    #[error("not found")]
    NotFound,
    #[error("rate limited by MusicBrainz")]
    RateLimited,
    #[error("MusicBrainz returned HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("transport error: {0}")]
    Transport(String),
    #[error("cannot parse MusicBrainz response: {0}")]
    Parse(String),
}
