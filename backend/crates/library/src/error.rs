use nimbus_musicbrainz::MbError;

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    /// MBID не найден в MusicBrainz.
    #[error("not found in MusicBrainz")]
    MbNotFound,
    /// MusicBrainz недоступен (сеть, лимиты, 5xx).
    #[error("MusicBrainz is unavailable: {0}")]
    MbUnavailable(String),
    /// Запись не входит ни в один релиз / в треклист выбранного альбома.
    #[error("recording is not part of the release")]
    RecordingNotInRelease,
    /// Сущность не найдена в нашей БД.
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

impl From<MbError> for LibraryError {
    fn from(e: MbError) -> Self {
        match e {
            MbError::NotFound => LibraryError::MbNotFound,
            other => LibraryError::MbUnavailable(other.to_string()),
        }
    }
}
