//! Синхронизация клиента: снимок и дельта по номеру транзакции (шаг 34).
//!
//! Модель согласованности: каждую синхронизируемую строку последней записала транзакция
//! `sync_txid` (ставит триггер, миграция `0012_sync.sql`). Ответ формируется в одной транзакции
//! `REPEATABLE READ READ ONLY`; курсор ответа — `xmin` её снимка, то есть номер самой старой ещё
//! не завершённой транзакции. Любая транзакция, не видимая этому ответу, имела номер `>= xmin`,
//! поэтому дельта «все строки с `sync_txid >= курсор`» не пропускает изменений (но может повторить
//! уже известные — клиент делает upsert). Удаления — таблица надгробий `sync_tombstones`.

use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::stream::BoxStream;
use sqlx::postgres::PgRow;
use sqlx::{FromRow, PgConnection, PgPool, Postgres, Transaction};
use uuid::Uuid;

/// Версия формата курсора и снимка; несовпадение у клиента — повод взять снимок заново.
pub const SYNC_SCHEMA: i32 = 3;

/// Не больше стольких строк (вместе с надгробиями) в одном ответе дельты.
pub const CHANGES_LIMIT: usize = 5000;

/// Как долго живут надгробия: клиент, не заходивший дольше, берёт снимок заново.
pub const TOMBSTONE_RETENTION: Duration = Duration::from_secs(30 * 24 * 3600);

#[derive(Debug, Clone, FromRow)]
pub struct SyncArtist {
    pub id: i64,
    /// Транзакция последней записи строки (служебное, в DTO не попадает).
    pub sync_txid: i64,
    pub mbid: Uuid,
    pub name: String,
    pub sort_name: Option<String>,
    pub disambiguation: Option<String>,
    pub in_library: bool,
    pub added_at: Option<DateTime<Utc>>,
    /// Есть ли фото: `'yes'` / `'no'`; `None` — ещё не искали.
    pub image: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct SyncAlbum {
    pub id: i64,
    /// Транзакция последней записи строки (служебное, в DTO не попадает).
    pub sync_txid: i64,
    pub mbid: Uuid,
    pub artist_id: i64,
    pub title: String,
    pub year: Option<i32>,
    pub primary_type: Option<String>,
    pub secondary_types: Vec<String>,
    pub cover_url: Option<String>,
    pub in_library: bool,
    pub added_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow)]
pub struct SyncTrack {
    pub id: i64,
    /// Транзакция последней записи строки (служебное, в DTO не попадает).
    pub sync_txid: i64,
    pub mbid_recording: Uuid,
    pub album_id: i64,
    pub artist_id: i64,
    pub title: String,
    pub disc_no: i32,
    pub position: i32,
    pub duration_ms: Option<i32>,
    pub status: nimbus_core::model::TrackStatus,
    pub status_reason: Option<String>,
    pub in_library: bool,
    pub added_at: Option<DateTime<Utc>>,
    pub needs_confirmation: bool,
    /// Primary-источник нужно перекодировать (иначе — `direct`).
    pub transcode: bool,
    pub play_count: i32,
    pub last_played_at: Option<DateTime<Utc>>,
    /// Закрепление трека на сервере (`pinned_tracks.state`); `None` — не закреплён.
    pub pin: Option<nimbus_core::model::PinState>,
    /// Причина `pin = failed`.
    pub pin_error: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct SyncPlaylist {
    pub id: i64,
    /// Транзакция последней записи строки (служебное, в DTO не попадает).
    pub sync_txid: i64,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct SyncPlaylistTrack {
    pub id: i64,
    /// Транзакция последней записи строки (служебное, в DTO не попадает).
    pub sync_txid: i64,
    pub playlist_id: i64,
    pub track_id: i64,
    pub added_at: DateTime<Utc>,
}

/// Синхронизируемая сущность. Порядок вариантов — порядок в снимке и в дельте (`rank`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entity {
    Artist,
    Album,
    Track,
    Playlist,
    PlaylistTrack,
}

impl Entity {
    pub fn as_str(self) -> &'static str {
        match self {
            Entity::Artist => "artist",
            Entity::Album => "album",
            Entity::Track => "track",
            Entity::Playlist => "playlist",
            Entity::PlaylistTrack => "playlist_track",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "artist" => Entity::Artist,
            "album" => Entity::Album,
            "track" => Entity::Track,
            "playlist" => Entity::Playlist,
            "playlist_track" => Entity::PlaylistTrack,
            _ => return None,
        })
    }

    fn rank(self) -> i32 {
        self as i32
    }
}

/// Позиция в упорядоченной ленте изменений `(sync_txid, rank сущности, id)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Position {
    pub txid: i64,
    pub rank: i32,
    pub id: i64,
}

/// Курсор клиента. `base` — граница безопасности: все строки с `sync_txid >= base` ещё могут быть
/// не доставлены. `after` — позиция внутри постраничной выдачи (когда изменений больше лимита);
/// без неё выдача начинается с `base`.
///
/// Почему не просто «txid последней строки»: тысячи строк одной транзакции (массовый импорт) имеют
/// один и тот же txid, и такой курсор не продвигался бы. А `base` постраничной серии — `xmin`
/// снимка её **первой** страницы: строка, закоммиченная между страницами, но с txid не больше
/// позиции, не попала бы ни на одну страницу, зато гарантированно имеет txid `>= xmin` первого снимка.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncCursor {
    pub base: i64,
    pub after: Option<Position>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorError {
    /// Строка не разбирается.
    Malformed,
    /// Другая версия формата или другая база: курсор бесполезен, нужен снимок.
    Foreign,
}

impl SyncCursor {
    /// Непрозрачная строка `"<schema>.<epoch>.<base>"` или
    /// `"<schema>.<epoch>.<base>.<txid>.<rank>.<id>"` (продолжение постраничной выдачи).
    pub fn encode(&self, epoch: &str) -> String {
        match self.after {
            None => format!("{SYNC_SCHEMA}.{epoch}.{}", self.base),
            Some(p) => format!(
                "{SYNC_SCHEMA}.{epoch}.{}.{}.{}.{}",
                self.base, p.txid, p.rank, p.id
            ),
        }
    }

    pub fn parse(s: &str, epoch: &str) -> Result<Self, CursorError> {
        let parts: Vec<&str> = s.split('.').collect();
        if parts.len() != 3 && parts.len() != 6 {
            return Err(CursorError::Malformed);
        }
        let schema: i32 = parts[0].parse().map_err(|_| CursorError::Malformed)?;
        let num = |s: &str| -> Result<i64, CursorError> {
            s.parse::<i64>()
                .ok()
                .filter(|n| *n >= 0)
                .ok_or(CursorError::Malformed)
        };
        let base = num(parts[2])?;
        let after = if parts.len() == 6 {
            Some(Position {
                txid: num(parts[3])?,
                rank: i32::try_from(num(parts[4])?).map_err(|_| CursorError::Malformed)?,
                id: num(parts[5])?,
            })
        } else {
            None
        };
        if schema != SYNC_SCHEMA || parts[1] != epoch {
            return Err(CursorError::Foreign);
        }
        Ok(Self { base, after })
    }

    /// Позиция, строго после которой выдаются изменения.
    fn start(&self) -> Position {
        self.after.unwrap_or(Position {
            txid: self.base,
            rank: -1,
            id: -1,
        })
    }
}

/// Идентификатор базы и нижняя граница курсоров.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Meta {
    pub epoch: String,
    /// Курсоры с `base < floor` недействительны: надгробия до `floor` уже вычищены.
    pub floor: i64,
}

pub async fn meta(conn: &mut PgConnection) -> sqlx::Result<Meta> {
    let (epoch, floor): (String, i64) = sqlx::query_as(
        "SELECT value->>'epoch', COALESCE((value->>'floor')::bigint, 0) FROM settings WHERE key = 'sync'",
    )
    .fetch_one(conn)
    .await?;
    Ok(Meta { epoch, floor })
}

/// Границы снимка транзакции.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Snapshot {
    /// Самая старая ещё не завершённая транзакция на момент снимка — курсор ответа.
    pub xmin: i64,
    /// Номер, с которого транзакции на момент снимка ещё не существовали.
    pub xmax: i64,
}

/// Открывает `REPEATABLE READ READ ONLY` и фиксирует снимок. Транзакцию нужно держать открытой,
/// пока читаются данные ответа, и закрыть сразу после (долгая транзакция держит `xmin` базы).
pub async fn begin_snapshot(
    pool: &PgPool,
) -> sqlx::Result<(Transaction<'static, Postgres>, Snapshot)> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let (xmin, xmax): (i64, i64) = sqlx::query_as(
        "SELECT txid_snapshot_xmin(txid_current_snapshot()), txid_snapshot_xmax(txid_current_snapshot())",
    )
    .fetch_one(&mut *tx)
    .await?;
    Ok((tx, Snapshot { xmin, xmax }))
}

const ARTIST_SELECT: &str = "SELECT id, sync_txid, mbid, name, sort_name, disambiguation, in_library, added_at, image FROM artists";

const ALBUM_SELECT: &str =
    "SELECT id, sync_txid, mbid_release_group AS mbid, artist_id, title, year, primary_type,
    secondary_types, cover_url, in_library, added_at FROM albums";

// `needs_confirmation` и `transcode` — те же выражения, что в `TrackView` (`views.rs`).
const TRACK_SELECT: &str = concat!(
    "SELECT t.id, t.sync_txid, t.mbid_recording, t.album_id, t.artist_id, t.title, t.disc_no, t.position,
            t.duration_ms, t.status, t.status_reason, t.in_library, t.added_at,
            ",
    super::views::needs_confirmation_sql!(),
    " AS needs_confirmation,
            ",
    super::views::transcode_sql!(),
    " AS transcode,
            COALESCE(tp.play_count, 0) AS play_count, tp.last_played_at,
            pt.state AS pin, pt.error AS pin_error
     FROM tracks t LEFT JOIN track_plays tp ON tp.track_id = t.id
                   LEFT JOIN pinned_tracks pt ON pt.track_id = t.id"
);

const PLAYLIST_SELECT: &str = "SELECT id, sync_txid, name, created_at, last_used_at FROM playlists";

const PLAYLIST_TRACK_SELECT: &str =
    "SELECT id, sync_txid, playlist_id, track_id, added_at FROM playlist_tracks";

// Потоковые выборки всех строк (для снимка): `fetch`, а не `fetch_all` — 60 000 треков не должны
// жить в памяти целиком. Порядок строк внутри сущности не гарантируется и не нужен.

pub fn artists(conn: &mut PgConnection) -> BoxStream<'_, sqlx::Result<SyncArtist>> {
    sqlx::query_as(ARTIST_SELECT).fetch(conn)
}

pub fn albums(conn: &mut PgConnection) -> BoxStream<'_, sqlx::Result<SyncAlbum>> {
    sqlx::query_as(ALBUM_SELECT).fetch(conn)
}

pub fn tracks(conn: &mut PgConnection) -> BoxStream<'_, sqlx::Result<SyncTrack>> {
    sqlx::query_as(TRACK_SELECT).fetch(conn)
}

pub fn playlists(conn: &mut PgConnection) -> BoxStream<'_, sqlx::Result<SyncPlaylist>> {
    sqlx::query_as(PLAYLIST_SELECT).fetch(conn)
}

pub fn playlist_tracks(conn: &mut PgConnection) -> BoxStream<'_, sqlx::Result<SyncPlaylistTrack>> {
    sqlx::query_as(PLAYLIST_TRACK_SELECT).fetch(conn)
}

/// Изменения после позиции курсора, не больше [`CHANGES_LIMIT`] строк (с надгробиями).
#[derive(Debug, Default)]
pub struct Changes {
    pub artists: Vec<SyncArtist>,
    pub albums: Vec<SyncAlbum>,
    pub tracks: Vec<SyncTrack>,
    pub playlists: Vec<SyncPlaylist>,
    pub playlist_tracks: Vec<SyncPlaylistTrack>,
    pub deleted: Vec<(Entity, i64)>,
    /// Есть ещё изменения за пределами лимита.
    pub more: bool,
    /// Позиция последней отданной строки (для продолжения при `more`).
    pub last: Option<Position>,
}

enum Item {
    Artist(SyncArtist),
    Album(SyncAlbum),
    Track(SyncTrack),
    Playlist(SyncPlaylist),
    PlaylistTrack(SyncPlaylistTrack),
    Deleted(Entity, i64),
}

type Keyed = Vec<(Position, Item)>;

/// Строки одной сущности строго после `from` по `(sync_txid, rank, id)`, не больше `limit`.
/// `col` — префикс столбцов в `select` (`"t."` у треков), `key` достаёт `(sync_txid, id)` строки.
async fn delta<T>(
    conn: &mut PgConnection,
    select: &str,
    col: &str,
    entity: Entity,
    from: Position,
    limit: usize,
    key: fn(&T) -> (i64, i64),
) -> sqlx::Result<Vec<(Position, T)>>
where
    T: for<'r> FromRow<'r, PgRow> + Send + Unpin,
{
    let rank = entity.rank();
    let sql = format!(
        "{select} WHERE {col}sync_txid >= $1
           AND ({col}sync_txid, {rank}::int, {col}id) > ($1, $2::int, $3)
         ORDER BY {col}sync_txid, {col}id LIMIT $4"
    );
    let rows: Vec<T> = sqlx::query_as(&sql)
        .bind(from.txid)
        .bind(from.rank)
        .bind(from.id)
        .bind(limit as i64)
        .fetch_all(conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let (txid, id) = key(&r);
            (Position { txid, rank, id }, r)
        })
        .collect())
}

/// Надгробия после `from`, кроме тех, чья строка существует снова (в одном ответе живая строка
/// и её надгробие не встречаются — клиент на это полагается).
async fn tombstones(
    conn: &mut PgConnection,
    from: Position,
    limit: usize,
) -> sqlx::Result<Vec<(Position, Entity)>> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT s.entity, s.entity_id, s.sync_txid
           FROM sync_tombstones s,
                LATERAL (SELECT CASE s.entity WHEN 'artist' THEN 0 WHEN 'album' THEN 1 WHEN 'track' THEN 2
                                              WHEN 'playlist' THEN 3 ELSE 4 END AS rank) r
          WHERE s.sync_txid >= $1
            AND (s.sync_txid, r.rank, s.entity_id) > ($1, $2::int, $3)
            AND NOT CASE s.entity
                  WHEN 'artist'   THEN EXISTS (SELECT 1 FROM artists WHERE id = s.entity_id)
                  WHEN 'album'    THEN EXISTS (SELECT 1 FROM albums WHERE id = s.entity_id)
                  WHEN 'track'    THEN EXISTS (SELECT 1 FROM tracks WHERE id = s.entity_id)
                  WHEN 'playlist' THEN EXISTS (SELECT 1 FROM playlists WHERE id = s.entity_id)
                  ELSE EXISTS (SELECT 1 FROM playlist_tracks WHERE id = s.entity_id) END
          ORDER BY s.sync_txid, r.rank, s.entity_id LIMIT $4",
    )
    .bind(from.txid)
    .bind(from.rank)
    .bind(from.id)
    .bind(limit as i64)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(entity, id, txid)| {
            // CHECK-ограничение таблицы допускает только известные значения.
            let entity = Entity::parse(&entity)?;
            Some((
                Position {
                    txid,
                    rank: entity.rank(),
                    id,
                },
                entity,
            ))
        })
        .collect())
}

/// Изменения после позиции курсора (в рамках транзакции снимка `conn`), не больше `limit` строк
/// по возрастанию `(sync_txid, rank, id)`.
pub async fn changes_since(
    conn: &mut PgConnection,
    cursor: &SyncCursor,
    limit: usize,
) -> sqlx::Result<Changes> {
    let from = cursor.start();
    // Каждая сущность отдаёт не больше `limit + 1` строк: после слияния этого хватает, чтобы
    // и взять первые `limit`, и узнать, есть ли ещё.
    let n = limit + 1;
    let mut all: Keyed = Vec::new();
    all.extend(
        delta::<SyncArtist>(conn, ARTIST_SELECT, "", Entity::Artist, from, n, |r| {
            (r.sync_txid, r.id)
        })
        .await?
        .into_iter()
        .map(|(k, r)| (k, Item::Artist(r))),
    );
    all.extend(
        delta::<SyncAlbum>(conn, ALBUM_SELECT, "", Entity::Album, from, n, |r| {
            (r.sync_txid, r.id)
        })
        .await?
        .into_iter()
        .map(|(k, r)| (k, Item::Album(r))),
    );
    all.extend(
        delta::<SyncTrack>(conn, TRACK_SELECT, "t.", Entity::Track, from, n, |r| {
            (r.sync_txid, r.id)
        })
        .await?
        .into_iter()
        .map(|(k, r)| (k, Item::Track(r))),
    );
    all.extend(
        delta::<SyncPlaylist>(conn, PLAYLIST_SELECT, "", Entity::Playlist, from, n, |r| {
            (r.sync_txid, r.id)
        })
        .await?
        .into_iter()
        .map(|(k, r)| (k, Item::Playlist(r))),
    );
    all.extend(
        delta::<SyncPlaylistTrack>(
            conn,
            PLAYLIST_TRACK_SELECT,
            "",
            Entity::PlaylistTrack,
            from,
            n,
            |r| (r.sync_txid, r.id),
        )
        .await?
        .into_iter()
        .map(|(k, r)| (k, Item::PlaylistTrack(r))),
    );
    all.extend(
        tombstones(conn, from, n)
            .await?
            .into_iter()
            .map(|(k, e)| (k, Item::Deleted(e, k.id))),
    );
    // Ключи уникальны: живая строка и её надгробие не встречаются вместе, а разные сущности
    // различаются `rank`.
    all.sort_by_key(|(k, _)| *k);
    let mut out = Changes {
        more: all.len() > limit,
        ..Changes::default()
    };
    all.truncate(limit);
    out.last = all.last().map(|(k, _)| *k);
    for (_, item) in all {
        match item {
            Item::Artist(r) => out.artists.push(r),
            Item::Album(r) => out.albums.push(r),
            Item::Track(r) => out.tracks.push(r),
            Item::Playlist(r) => out.playlists.push(r),
            Item::PlaylistTrack(r) => out.playlist_tracks.push(r),
            Item::Deleted(e, id) => out.deleted.push((e, id)),
        }
    }
    Ok(out)
}

/// Удаляет надгробия старше `older_than` и поднимает `floor`: клиенты с курсором ниже `floor`
/// могли пропустить удаления и обязаны взять снимок. Возвращает число удалённых надгробий.
pub async fn purge_tombstones(pool: &PgPool, older_than: Duration) -> sqlx::Result<u64> {
    let mut tx = pool.begin().await?;
    let (count, max_txid): (i64, Option<i64>) = sqlx::query_as(
        "WITH d AS (
            DELETE FROM sync_tombstones WHERE deleted_at < now() - make_interval(secs => $1)
            RETURNING sync_txid)
         SELECT count(*), max(sync_txid) FROM d",
    )
    .bind(older_than.as_secs_f64())
    .fetch_one(&mut *tx)
    .await?;
    if let Some(max) = max_txid {
        // `floor` только растёт.
        sqlx::query(
            "UPDATE settings
                SET value = jsonb_set(value, '{floor}',
                      to_jsonb(GREATEST(COALESCE((value->>'floor')::bigint, 0), $1))),
                    updated_at = now()
              WHERE key = 'sync'",
        )
        .bind(max + 1)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(count as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_roundtrip_plain_and_continued() {
        let plain = SyncCursor {
            base: 42,
            after: None,
        };
        assert_eq!(plain.encode("e-1"), "3.e-1.42");
        assert_eq!(SyncCursor::parse("3.e-1.42", "e-1"), Ok(plain));
        let cont = SyncCursor {
            base: 42,
            after: Some(Position {
                txid: 50,
                rank: 2,
                id: 7,
            }),
        };
        assert_eq!(cont.encode("e-1"), "3.e-1.42.50.2.7");
        assert_eq!(SyncCursor::parse(&cont.encode("e-1"), "e-1"), Ok(cont));
    }

    #[test]
    fn cursor_rejects_garbage_and_foreign() {
        for bad in [
            "",
            "1",
            "1.e",
            "1.e.x",
            "1.e.-5",
            "1.e.1.2",
            "1.e.1.2.3",
            "a.e.1",
            "1.e.1.2.99999999999.3",
        ] {
            assert_eq!(
                SyncCursor::parse(bad, "e"),
                Err(CursorError::Malformed),
                "{bad}"
            );
        }
        assert_eq!(
            SyncCursor::parse("3.other.5", "e"),
            Err(CursorError::Foreign)
        );
        assert_eq!(SyncCursor::parse("1.e.5", "e"), Err(CursorError::Foreign));
    }

    #[test]
    fn entity_names_roundtrip_in_rank_order() {
        let all = [
            Entity::Artist,
            Entity::Album,
            Entity::Track,
            Entity::Playlist,
            Entity::PlaylistTrack,
        ];
        for (i, e) in all.iter().enumerate() {
            assert_eq!(Entity::parse(e.as_str()), Some(*e));
            assert_eq!(e.rank(), i as i32);
        }
        assert_eq!(Entity::parse("nope"), None);
    }
}

#[cfg(test)]
mod cursor_props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn encode_parse_is_identity(
            base in 0i64..i64::MAX,
            after in proptest::option::of((0i64..i64::MAX, 0i32..i32::MAX, 0i64..i64::MAX)),
            epoch in "[a-z0-9-]{1,12}",
        ) {
            let c = SyncCursor { base, after: after.map(|(txid, rank, id)| Position { txid, rank, id }) };
            prop_assert_eq!(SyncCursor::parse(&c.encode(&epoch), &epoch), Ok(c));
        }

        /// Мусор — ошибка (в API это 400/снимок), но не паника.
        #[test]
        fn garbage_never_panics(s in ".{0,60}") {
            let _ = SyncCursor::parse(&s, "e");
        }
    }
}
