//! Типы фоновых задач.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Приоритет задач, запущенных действием пользователя (добавить альбом/трек, повтор, свой magnet).
pub const PRIORITY_INTERACTIVE: i16 = 10;
/// Приоритет по умолчанию (массовый импорт, обычный поиск).
pub const PRIORITY_NORMAL: i16 = 0;
/// Приоритет фоновой работы (резервные источники, авто-повторы, вытеснение кэша).
pub const PRIORITY_BACKGROUND: i16 = -10;
const _: () =
    assert!(PRIORITY_INTERACTIVE > PRIORITY_NORMAL && PRIORITY_NORMAL > PRIORITY_BACKGROUND);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum Job {
    DiscoverAlbum {
        album_id: i64,
    },
    DiscoverArtist {
        artist_id: i64,
    },
    /// Импорт дискографии артиста, добавленного в библиотеку (метаданные альбомов и треков из MB).
    ImportArtist {
        artist_id: i64,
    },
    VerifyTorrent {
        torrent_id: i64,
        album_id: i64,
    },
    /// Разбор CUE-файла раздачи «образ + cue» (шаг 21).
    ProcessCue {
        torrent_id: i64,
        album_id: i64,
        cue_file_index: i32,
    },
    /// Вытеснение давно не игравших файлов, когда кэш больше лимита (шаг 22).
    EvictCache,
    /// Автоматический повтор поиска для альбомов `missing`/`partial`, у которых подошёл `next_retry_at` (шаг 32).
    RetryMissing,
}

impl Job {
    pub const DISCOVER_ALBUM: &'static str = "discover_album";
    pub const DISCOVER_ARTIST: &'static str = "discover_artist";
    pub const IMPORT_ARTIST: &'static str = "import_artist";
    pub const VERIFY_TORRENT: &'static str = "verify_torrent";
    pub const PROCESS_CUE: &'static str = "process_cue";
    pub const EVICT_CACHE: &'static str = "evict_cache";
    pub const RETRY_MISSING: &'static str = "retry_missing";

    pub fn kind(&self) -> &'static str {
        match self {
            Job::DiscoverAlbum { .. } => Self::DISCOVER_ALBUM,
            Job::DiscoverArtist { .. } => Self::DISCOVER_ARTIST,
            Job::ImportArtist { .. } => Self::IMPORT_ARTIST,
            Job::VerifyTorrent { .. } => Self::VERIFY_TORRENT,
            Job::ProcessCue { .. } => Self::PROCESS_CUE,
            Job::EvictCache => Self::EVICT_CACHE,
            Job::RetryMissing => Self::RETRY_MISSING,
        }
    }

    /// Ключ дедупликации: пока задача с таким ключом активна (queued/running), дубликат не ставится.
    pub fn dedup_key(&self) -> Option<String> {
        Some(match self {
            Job::DiscoverAlbum { album_id } => format!("discover_album:{album_id}"),
            Job::DiscoverArtist { artist_id } => format!("discover_artist:{artist_id}"),
            Job::ImportArtist { artist_id } => format!("import_artist:{artist_id}"),
            Job::VerifyTorrent {
                torrent_id,
                album_id,
            } => format!("verify_torrent:{torrent_id}:{album_id}"),
            Job::ProcessCue {
                torrent_id,
                album_id,
                cue_file_index,
            } => format!("process_cue:{torrent_id}:{album_id}:{cue_file_index}"),
            Job::EvictCache => "evict_cache".to_string(),
            Job::RetryMissing => "retry_missing".to_string(),
        })
    }

    /// Пара (`jobs.kind`, `jobs.payload`).
    pub fn to_parts(&self) -> (&'static str, Value) {
        let mut v = serde_json::to_value(self).expect("Job serializes");
        let payload = v.get_mut("payload").map(Value::take).unwrap_or(Value::Null);
        (self.kind(), payload)
    }

    pub fn from_parts(kind: &str, payload: Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(serde_json::json!({ "kind": kind, "payload": payload }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evict_cache_roundtrips_without_payload() {
        let (kind, payload) = Job::EvictCache.to_parts();
        assert_eq!(kind, "evict_cache");
        assert_eq!(Job::from_parts(kind, payload).unwrap(), Job::EvictCache);
        assert_eq!(Job::EvictCache.dedup_key().as_deref(), Some("evict_cache"));
    }

    #[test]
    fn retry_missing_roundtrips_without_payload() {
        let (kind, payload) = Job::RetryMissing.to_parts();
        assert_eq!(kind, "retry_missing");
        assert_eq!(Job::from_parts(kind, payload).unwrap(), Job::RetryMissing);
        assert_eq!(
            Job::RetryMissing.dedup_key().as_deref(),
            Some("retry_missing")
        );
    }

    #[test]
    fn parts_roundtrip() {
        let j = Job::VerifyTorrent {
            torrent_id: 7,
            album_id: 42,
        };
        let (kind, payload) = j.to_parts();
        assert_eq!(kind, "verify_torrent");
        assert_eq!(
            payload,
            serde_json::json!({"torrent_id": 7, "album_id": 42})
        );
        assert_eq!(Job::from_parts(kind, payload).unwrap(), j);
        assert_eq!(j.dedup_key().as_deref(), Some("verify_torrent:7:42"));
        assert_eq!(
            Job::DiscoverAlbum { album_id: 42 }.dedup_key().as_deref(),
            Some("discover_album:42")
        );
    }

    #[test]
    fn import_artist_job() {
        let j = Job::ImportArtist { artist_id: 3 };
        assert_eq!(j.dedup_key().as_deref(), Some("import_artist:3"));
        let (kind, payload) = j.to_parts();
        assert_eq!(kind, "import_artist");
        assert_eq!(payload, serde_json::json!({"artist_id": 3}));
        assert_eq!(Job::from_parts(kind, payload).unwrap(), j);
    }

    #[test]
    fn unknown_kind_is_error() {
        assert!(Job::from_parts("nope", serde_json::json!({})).is_err());
    }
}
