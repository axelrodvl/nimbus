//! Доменные типы: перечисления, строки таблиц и структуры для вставки.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
#[error("invalid {kind} value: {value:?}")]
pub struct ParseEnumError {
    pub kind: &'static str,
    pub value: String,
}

/// Перечисление, хранимое в БД как TEXT (snake_case).
macro_rules! text_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $s:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $s)] $variant),+
        }

        impl $name {
            pub fn as_str(&self) -> &'static str {
                match self { $(Self::$variant => $s),+ }
            }
        }

        // Схема OpenAPI пишется вручную: derive `ToSchema` не видит `serde(rename)` из макроса,
        // и в спецификацию попадали бы имена вариантов (`Adding`) вместо значений на проводе (`adding`).
        impl utoipa::PartialSchema for $name {
            fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
                utoipa::openapi::schema::ObjectBuilder::new()
                    .schema_type(utoipa::openapi::schema::SchemaType::Type(utoipa::openapi::schema::Type::String))
                    .enum_values(Some([$($s),+]))
                    .into()
            }
        }

        impl utoipa::ToSchema for $name {
            fn name() -> std::borrow::Cow<'static, str> {
                std::borrow::Cow::Borrowed(stringify!($name))
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl std::str::FromStr for $name {
            type Err = ParseEnumError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($s => Ok(Self::$variant),)+
                    other => Err(ParseEnumError { kind: stringify!($name), value: other.to_string() }),
                }
            }
        }

        impl sqlx::Type<sqlx::Postgres> for $name {
            fn type_info() -> sqlx::postgres::PgTypeInfo {
                <str as sqlx::Type<sqlx::Postgres>>::type_info()
            }
            fn compatible(ty: &sqlx::postgres::PgTypeInfo) -> bool {
                <str as sqlx::Type<sqlx::Postgres>>::compatible(ty)
            }
        }

        impl<'q> sqlx::Encode<'q, sqlx::Postgres> for $name {
            fn encode_by_ref(
                &self,
                buf: &mut sqlx::postgres::PgArgumentBuffer,
            ) -> Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
                <&str as sqlx::Encode<sqlx::Postgres>>::encode_by_ref(&self.as_str(), buf)
            }
        }

        impl<'r> sqlx::Decode<'r, sqlx::Postgres> for $name {
            fn decode(value: sqlx::postgres::PgValueRef<'r>) -> Result<Self, sqlx::error::BoxDynError> {
                let s = <&str as sqlx::Decode<sqlx::Postgres>>::decode(value)?;
                Ok(s.parse()?)
            }
        }
    };
}

text_enum!(
    /// Статус трека (жизненный цикл см. PLAN.md).
    TrackStatus {
        Adding => "adding",
        Found => "found",
        NotFound => "not_found",
        Ready => "ready",
    }
);

text_enum!(
    /// Причина статуса `not_found` (колонка `tracks.status_reason`);
    /// `search_failed` — поиск не удался (ошибки до исчерпания попыток).
    NotFoundReason {
        NoTorrents => "no_torrents",
        DeadTorrents => "dead_torrents",
        NoMatch => "no_match",
        SearchFailed => "search_failed",
    }
);

text_enum!(
    /// Вычисляемое состояние «приобретения» альбома по его трекам из библиотеки (шаг 32).
    /// Приоритет при совпадении условий: `searching` > `downloading` > `partial` > `missing` > `available` > `downloaded`.
    AcquisitionState {
        Searching => "searching",
        Downloading => "downloading",
        Partial => "partial",
        Missing => "missing",
        Available => "available",
        Downloaded => "downloaded",
    }
);

text_enum!(
    /// Состояние закрепления трека (`pinned_tracks.state`, шаг 33); тот же набор — агрегат по альбому.
    PinState {
        Queued => "queued",
        Downloading => "downloading",
        Done => "done",
        WaitingSource => "waiting_source",
        Failed => "failed",
    }
);

text_enum!(
    /// Итог последнего завершённого поиска раздач альбома (`album_search_state.last_outcome`).
    SearchOutcome {
        Found => "found",
        Partial => "partial",
        NoTorrents => "no_torrents",
        DeadTorrents => "dead_torrents",
        NoMatch => "no_match",
        SearchFailed => "search_failed",
    }
);

text_enum!(
    TorrentKind {
        Album => "album",
        Discography => "discography",
        Single => "single",
        Unknown => "unknown",
    }
);

text_enum!(
    MetaStatus {
        Pending => "pending",
        Fetching => "fetching",
        Ok => "ok",
        Timeout => "timeout",
        Dead => "dead",
        Error => "error",
    }
);

text_enum!(
    TorrentSource {
        Tpb => "tpb",
        Rutracker => "rutracker",
        Torznab => "torznab",
        Manual => "manual",
    }
);

// ---------------------------------------------------------------- InfoHash

/// Info-hash торрента: 40 hex-символов в нижнем регистре.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct InfoHash(String);

#[derive(Debug, thiserror::Error)]
#[error("invalid info hash: {0:?}")]
pub struct InvalidInfoHash(pub String);

impl InfoHash {
    /// Принимает hex (40 символов, любой регистр) или base32 (32 символа).
    pub fn parse(s: &str) -> Result<Self, InvalidInfoHash> {
        let s = s.trim();
        let bad = || InvalidInfoHash(s.to_string());
        match s.len() {
            40 if s.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(Self(s.to_ascii_lowercase())),
            32 => {
                let bytes = base32_decode(s).ok_or_else(bad)?;
                Ok(Self(bytes.iter().map(|b| format!("{b:02x}")).collect()))
            }
            _ => Err(bad()),
        }
    }

    /// Достаёт info-hash из magnet-ссылки (`xt=urn:btih:...`).
    pub fn from_magnet(magnet: &str) -> Option<Self> {
        let query = magnet.strip_prefix("magnet:?")?;
        query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .filter(|(k, _)| k.eq_ignore_ascii_case("xt"))
            .find_map(|(_, v)| {
                let v = v
                    .strip_prefix("urn:btih:")
                    .or_else(|| v.strip_prefix("URN:BTIH:"))?;
                Self::parse(v).ok()
            })
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for InfoHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for InfoHash {
    type Err = InvalidInfoHash;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return None,
        } as u32;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

// ---------------------------------------------------------------- строки таблиц

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Artist {
    pub id: i64,
    pub mbid: Uuid,
    pub name: String,
    pub sort_name: Option<String>,
    pub disambiguation: Option<String>,
    pub in_library: bool,
    pub added_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Album {
    pub id: i64,
    pub mbid_release_group: Uuid,
    pub mbid_release: Option<Uuid>,
    pub artist_id: i64,
    pub title: String,
    pub primary_type: Option<String>,
    pub secondary_types: Vec<String>,
    pub year: Option<i32>,
    pub cover_url: Option<String>,
    pub in_library: bool,
    pub added_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Track {
    pub id: i64,
    pub mbid_recording: Uuid,
    pub mbid_track: Option<Uuid>,
    pub album_id: i64,
    pub artist_id: i64,
    pub title: String,
    pub disc_no: i32,
    pub position: i32,
    pub duration_ms: Option<i32>,
    pub status: TrackStatus,
    pub status_reason: Option<String>,
    pub in_library: bool,
    pub added_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

/// `.torrent` больше этого размера не сохраняется (защита БД и памяти от гигантских файлов).
pub const MAX_TORRENT_FILE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Torrent {
    pub id: i64,
    pub info_hash: String,
    pub magnet: String,
    pub source: TorrentSource,
    pub source_topic_id: Option<String>,
    pub title: String,
    pub size_bytes: Option<i64>,
    pub seeders: Option<i32>,
    pub leechers: Option<i32>,
    pub kind: TorrentKind,
    pub meta_status: MetaStatus,
    /// Сколько раз запрашивали метаданные из сети: одна попытка — один запрос, сколько бы задач
    /// проверки (по альбомам дискографии) его ни ждало.
    pub meta_attempts: i32,
    pub meta_error: Option<String>,
    pub fetched_at: Option<DateTime<Utc>>,
    /// В БД сохранён `.torrent` (сам файл в модель не загружается).
    pub has_torrent_file: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct TorrentFile {
    pub torrent_id: i64,
    pub file_index: i32,
    pub path: String,
    pub size_bytes: i64,
    pub ext: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AlbumTorrent {
    pub album_id: i64,
    pub torrent_id: i64,
    pub query: String,
    pub rank_score: f32,
    pub verified: bool,
    pub created_at: DateTime<Utc>,
}

/// Раздача альбома вместе с данными связи (результат `album_torrents::list_for_album`).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RankedTorrent {
    #[sqlx(flatten)]
    pub torrent: Torrent,
    pub link_query: String,
    pub rank_score: f32,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct TrackSource {
    pub id: i64,
    pub track_id: i64,
    pub torrent_id: i64,
    pub file_index: i32,
    pub match_score: f32,
    pub is_primary: bool,
    pub needs_confirmation: bool,
    pub cue_start_ms: Option<i32>,
    pub cue_end_ms: Option<i32>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Download {
    pub torrent_id: i64,
    pub file_index: i32,
    pub local_path: String,
    pub bytes_total: i64,
    pub bytes_done: i64,
    pub completed_at: Option<DateTime<Utc>>,
    pub last_played_at: Option<DateTime<Utc>>,
}

// ---------------------------------------------------------------- входные структуры

#[derive(Debug, Clone)]
pub struct NewArtist {
    pub mbid: Uuid,
    pub name: String,
    pub sort_name: Option<String>,
    pub disambiguation: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewAlbum {
    pub mbid_release_group: Uuid,
    pub mbid_release: Option<Uuid>,
    pub artist_id: i64,
    pub title: String,
    pub primary_type: Option<String>,
    pub secondary_types: Vec<String>,
    pub year: Option<i32>,
    pub cover_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewTrack {
    pub mbid_recording: Uuid,
    pub mbid_track: Option<Uuid>,
    pub album_id: i64,
    pub artist_id: i64,
    pub title: String,
    pub disc_no: i32,
    pub position: i32,
    pub duration_ms: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct NewTorrent {
    pub info_hash: InfoHash,
    pub magnet: String,
    pub source: TorrentSource,
    pub source_topic_id: Option<String>,
    pub title: String,
    pub size_bytes: Option<i64>,
    pub seeders: Option<i32>,
    pub leechers: Option<i32>,
    pub kind: TorrentKind,
}

#[derive(Debug, Clone)]
pub struct NewTorrentFile {
    pub file_index: i32,
    pub path: String,
    pub size_bytes: i64,
    pub ext: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewTrackSource {
    pub track_id: i64,
    pub torrent_id: i64,
    pub file_index: i32,
    pub match_score: f32,
    pub needs_confirmation: bool,
    pub cue_start_ms: Option<i32>,
    pub cue_end_ms: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct NewDownload {
    pub torrent_id: i64,
    pub file_index: i32,
    pub local_path: String,
    pub bytes_total: i64,
    pub bytes_done: i64,
}

#[derive(Debug, Clone, Default)]
pub struct TrackFilter {
    pub status: Option<TrackStatus>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX: &str = "c12fe1c06bba254a9dc9f519b335aa7c1367a88a";

    #[test]
    fn magnet_hex() {
        let m = format!(
            "magnet:?xt=urn:btih:{}&dn=Some+Album&tr=udp%3A%2F%2Fx",
            HEX.to_uppercase()
        );
        assert_eq!(InfoHash::from_magnet(&m).unwrap().as_str(), HEX);
    }

    #[test]
    fn magnet_xt_not_first() {
        let m = format!("magnet:?dn=x&xt=urn:btih:{HEX}");
        assert_eq!(InfoHash::from_magnet(&m).unwrap().as_str(), HEX);
    }

    #[test]
    fn magnet_base32() {
        // base32 от тех же 20 байт
        let b32 = "YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK";
        let m = format!("magnet:?xt=urn:btih:{b32}");
        assert_eq!(InfoHash::from_magnet(&m).unwrap().as_str(), HEX);
        assert_eq!(InfoHash::parse(&b32.to_lowercase()).unwrap().as_str(), HEX);
    }

    #[test]
    fn garbage() {
        assert!(InfoHash::from_magnet("not a magnet").is_none());
        assert!(InfoHash::from_magnet("magnet:?dn=only-name").is_none());
        assert!(InfoHash::from_magnet("magnet:?xt=urn:btih:zzzz").is_none());
        assert!(InfoHash::parse(&"g".repeat(40)).is_err());
        assert!(InfoHash::parse(&"1".repeat(41)).is_err());
        assert!(InfoHash::parse(&format!("{}!", "A".repeat(31))).is_err());
    }

    #[test]
    fn enums_roundtrip() {
        assert_eq!(
            "not_found".parse::<TrackStatus>().unwrap(),
            TrackStatus::NotFound
        );
        assert_eq!(TrackStatus::Ready.to_string(), "ready");
        assert!("bogus".parse::<TrackStatus>().is_err());
        assert_eq!(
            serde_json::to_string(&NotFoundReason::NoMatch).unwrap(),
            "\"no_match\""
        );
    }
}
