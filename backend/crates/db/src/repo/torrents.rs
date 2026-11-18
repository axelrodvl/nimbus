use nimbus_core::model::{MetaStatus, NewTorrent, NewTorrentFile, Torrent, TorrentFile};
use sqlx::{PgExecutor, PgPool};

/// Колонки модели `Torrent` для запросов с псевдонимом `t`: перечислены явно, чтобы не тянуть
/// `torrent_file` (мегабайты) в каждый запрос; вместо него — флаг `has_torrent_file`.
#[macro_export]
macro_rules! torrent_cols {
    () => {
        "t.id, t.info_hash, t.magnet, t.source, t.source_topic_id, t.title, t.size_bytes, \
         t.seeders, t.leechers, t.kind, t.meta_status, t.meta_attempts, t.meta_error, \
         t.fetched_at, (t.torrent_file IS NOT NULL) AS has_torrent_file, t.created_at"
    };
}

pub use nimbus_core::model::MAX_TORRENT_FILE_BYTES;

/// Upsert по info_hash. При конфликте обновляются только seeders/leechers/title.
pub async fn upsert_by_info_hash(db: impl PgExecutor<'_>, t: &NewTorrent) -> sqlx::Result<Torrent> {
    sqlx::query_as(
        concat!(
            "WITH t AS (
                INSERT INTO torrents (info_hash, magnet, source, source_topic_id, title, size_bytes, seeders, leechers, kind)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (info_hash) DO UPDATE SET
                   seeders = COALESCE(EXCLUDED.seeders, torrents.seeders),
                   leechers = COALESCE(EXCLUDED.leechers, torrents.leechers),
                   title = EXCLUDED.title,
                   last_used_at = now()
                RETURNING *)
             SELECT ",
            crate::torrent_cols!(),
            " FROM t"
        ),
    )
    .bind(t.info_hash.as_str())
    .bind(&t.magnet)
    .bind(t.source)
    .bind(&t.source_topic_id)
    .bind(&t.title)
    .bind(t.size_bytes)
    .bind(t.seeders)
    .bind(t.leechers)
    .bind(t.kind)
    .fetch_one(db)
    .await
}

pub async fn get(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<Option<Torrent>> {
    sqlx::query_as(concat!(
        "SELECT ",
        crate::torrent_cols!(),
        " FROM torrents t WHERE t.id = $1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

/// Меняет `meta_status`. `fetching` увеличивает `meta_attempts`, `ok` выставляет `fetched_at`.
/// Статус `ok` с файлами не понижается (поздний таймаут параллельной задачи не стирает успех):
/// тогда строка не меняется и возвращается как есть.
pub async fn set_meta_status(
    db: impl PgExecutor<'_>,
    id: i64,
    status: MetaStatus,
    error: Option<&str>,
) -> sqlx::Result<Torrent> {
    sqlx::query_as(concat!(
        "WITH t AS (
            UPDATE torrents SET
               meta_status = $2,
               meta_error = $3,
               meta_attempts = meta_attempts + CASE WHEN $2 = 'fetching' THEN 1 ELSE 0 END,
               fetched_at = CASE WHEN $2 = 'ok' THEN now() ELSE fetched_at END
            WHERE id = $1
              AND NOT ($2 IN ('fetching', 'timeout', 'dead', 'error')
                       AND meta_status = 'ok'
                       AND EXISTS (SELECT 1 FROM torrent_files f WHERE f.torrent_id = torrents.id))
            RETURNING *)
         SELECT ",
        crate::torrent_cols!(),
        " FROM (SELECT * FROM t UNION ALL SELECT * FROM torrents WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM t)) t"
    ))
    .bind(id)
    .bind(status)
    .bind(error)
    .fetch_one(db)
    .await
}

/// Заменяет набор файлов торрента целиком (в транзакции).
pub async fn replace_files(
    pool: &PgPool,
    torrent_id: i64,
    files: &[NewTorrentFile],
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM torrent_files WHERE torrent_id = $1")
        .bind(torrent_id)
        .execute(&mut *tx)
        .await?;
    if !files.is_empty() {
        let idx: Vec<i32> = files.iter().map(|f| f.file_index).collect();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        let sizes: Vec<i64> = files.iter().map(|f| f.size_bytes).collect();
        let exts: Vec<Option<&str>> = files.iter().map(|f| f.ext.as_deref()).collect();
        sqlx::query(
            "INSERT INTO torrent_files (torrent_id, file_index, path, size_bytes, ext)
             SELECT $1, * FROM UNNEST($2::int[], $3::text[], $4::bigint[], $5::text[])",
        )
        .bind(torrent_id)
        .bind(idx)
        .bind(paths)
        .bind(sizes)
        .bind(exts)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn files(db: impl PgExecutor<'_>, torrent_id: i64) -> sqlx::Result<Vec<TorrentFile>> {
    sqlx::query_as("SELECT * FROM torrent_files WHERE torrent_id = $1 ORDER BY file_index")
        .bind(torrent_id)
        .fetch_all(db)
        .await
}

/// Файл раздачи и трек, который на него сопоставлен (primary, затем лучший по `match_score`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FileWithMatch {
    pub file_index: i32,
    pub path: String,
    pub size_bytes: i64,
    pub ext: Option<String>,
    pub matched_track_id: Option<i64>,
}

pub async fn files_with_match(
    db: impl PgExecutor<'_>,
    torrent_id: i64,
) -> sqlx::Result<Vec<FileWithMatch>> {
    sqlx::query_as(
        "SELECT f.file_index, f.path, f.size_bytes, f.ext,
                (SELECT ts.track_id FROM track_sources ts
                  WHERE ts.torrent_id = f.torrent_id AND ts.file_index = f.file_index
                  ORDER BY ts.is_primary DESC, ts.match_score DESC, ts.id LIMIT 1) AS matched_track_id
         FROM torrent_files f WHERE f.torrent_id = $1 ORDER BY f.file_index",
    )
    .bind(torrent_id)
    .fetch_all(db)
    .await
}

/// Сохраняет `.torrent` раздачи. `false` — файл больше [`MAX_TORRENT_FILE_BYTES`] и не сохранён.
pub async fn set_torrent_file(
    db: impl PgExecutor<'_>,
    id: i64,
    bytes: &[u8],
) -> sqlx::Result<bool> {
    if bytes.len() > MAX_TORRENT_FILE_BYTES {
        tracing::warn!(
            torrent_id = id,
            size = bytes.len(),
            "torrent file is too large, not stored"
        );
        return Ok(false);
    }
    sqlx::query("UPDATE torrents SET torrent_file = $2 WHERE id = $1")
        .bind(id)
        .bind(bytes)
        .execute(db)
        .await?;
    Ok(true)
}

/// Сохранённый `.torrent` раздачи, если есть.
pub async fn torrent_file(db: impl PgExecutor<'_>, id: i64) -> sqlx::Result<Option<Vec<u8>>> {
    let row: Option<(Option<Vec<u8>>,)> =
        sqlx::query_as("SELECT torrent_file FROM torrents WHERE id = $1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.and_then(|(f,)| f))
}

/// Сохраняет `.torrent` по info-hash, если у раздачи его ещё нет (дозаполнение из сессии движка).
/// `true` — записано.
pub async fn fill_torrent_file_by_hash(
    db: impl PgExecutor<'_>,
    info_hash: &str,
    bytes: &[u8],
) -> sqlx::Result<bool> {
    if bytes.len() > MAX_TORRENT_FILE_BYTES {
        return Ok(false);
    }
    let r = sqlx::query(
        "UPDATE torrents SET torrent_file = $2 WHERE info_hash = $1 AND torrent_file IS NULL",
    )
    .bind(info_hash)
    .bind(bytes)
    .execute(db)
    .await?;
    Ok(r.rows_affected() > 0)
}
