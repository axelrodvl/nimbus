//! Закрепления треков (шаг 33): что сервер обязан скачать и не вытеснять из кэша.

use std::collections::HashSet;

use nimbus_core::model::{PinState, TrackStatus};
use sqlx::{PgConnection, PgExecutor};

/// Закрепление вместе с тем, что нужно менеджеру: статус трека и primary-источник.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PinWork {
    pub track_id: i64,
    pub album_id: i64,
    pub state: PinState,
    pub retries: i32,
    pub requested_at: chrono::DateTime<chrono::Utc>,
    pub track_status: TrackStatus,
    pub source_id: Option<i64>,
    pub torrent_id: Option<i64>,
    pub file_index: Option<i32>,
    pub info_hash: Option<String>,
    pub size_bytes: Option<i64>,
}

/// Закрепляет треки (идемпотентно). Начальное состояние — `queued`, если у трека есть источник
/// (`found`/`ready`), иначе `waiting_source`. Уже закреплённый трек остаётся в своём состоянии,
/// кроме `failed` (повторное закрепление ставит его в очередь заново). Возвращает число треков.
pub async fn pin_tracks(
    db: impl PgExecutor<'_>,
    track_ids: &[i64],
    album_pin: bool,
) -> sqlx::Result<u64> {
    if track_ids.is_empty() {
        return Ok(0);
    }
    let r = sqlx::query(
        "INSERT INTO pinned_tracks (track_id, album_pin, state)
         SELECT t.id, $2,
                CASE WHEN t.status IN ('found','ready') THEN 'queued' ELSE 'waiting_source' END
         FROM tracks t WHERE t.id = ANY($1)
         ON CONFLICT (track_id) DO UPDATE SET
            album_pin = pinned_tracks.album_pin OR EXCLUDED.album_pin,
            state = CASE WHEN pinned_tracks.state = 'failed' THEN 'queued' ELSE pinned_tracks.state END,
            error = CASE WHEN pinned_tracks.state = 'failed' THEN NULL ELSE pinned_tracks.error END,
            retries = CASE WHEN pinned_tracks.state = 'failed' THEN 0 ELSE pinned_tracks.retries END,
            updated_at = now()",
    )
    .bind(track_ids)
    .bind(album_pin)
    .execute(db)
    .await?;
    Ok(r.rows_affected())
}

/// Закрепляет все треки альбома, которые есть в библиотеке (`album_pin = true`).
pub async fn pin_album(db: &mut PgConnection, album_id: i64) -> sqlx::Result<u64> {
    let ids: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM tracks WHERE album_id = $1 AND in_library ORDER BY id")
            .bind(album_id)
            .fetch_all(&mut *db)
            .await?;
    pin_tracks(&mut *db, &ids, true).await
}

/// Снимает закрепление с треков альбома; возвращает id снятых треков.
pub async fn unpin_album(db: impl PgExecutor<'_>, album_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "DELETE FROM pinned_tracks WHERE track_id IN (SELECT id FROM tracks WHERE album_id = $1)
         RETURNING track_id",
    )
    .bind(album_id)
    .fetch_all(db)
    .await
}

/// Снимает закрепление с трека; `true`, если оно было.
pub async fn unpin_track(db: impl PgExecutor<'_>, track_id: i64) -> sqlx::Result<bool> {
    let r = sqlx::query("DELETE FROM pinned_tracks WHERE track_id = $1")
        .bind(track_id)
        .execute(db)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// Снимает закрепления с треков артиста (удаление артиста из библиотеки).
pub async fn unpin_artist(db: impl PgExecutor<'_>, artist_id: i64) -> sqlx::Result<u64> {
    let r = sqlx::query(
        "DELETE FROM pinned_tracks WHERE track_id IN (SELECT id FROM tracks WHERE artist_id = $1)",
    )
    .bind(artist_id)
    .execute(db)
    .await?;
    Ok(r.rows_affected())
}

/// Закрепления в работе (`queued`, `downloading`, `waiting_source`) с primary-источником, а также
/// `done` с треком, снова ставшим `found` (файл пропал с диска): его нужно скачать заново.
pub async fn list_open(db: impl PgExecutor<'_>) -> sqlx::Result<Vec<PinWork>> {
    sqlx::query_as(
        "SELECT p.track_id, t.album_id, p.state, p.retries, p.requested_at, t.status AS track_status,
                ts.id AS source_id, ts.torrent_id, ts.file_index, tr.info_hash,
                tf.size_bytes
         FROM pinned_tracks p
           JOIN tracks t ON t.id = p.track_id
           LEFT JOIN track_sources ts ON ts.track_id = p.track_id AND ts.is_primary
           LEFT JOIN torrents tr ON tr.id = ts.torrent_id
           LEFT JOIN torrent_files tf ON tf.torrent_id = ts.torrent_id AND tf.file_index = ts.file_index
         WHERE p.state IN ('queued','downloading','waiting_source')
            OR (p.state = 'done' AND t.status = 'found')
         ORDER BY p.requested_at, p.track_id",
    )
    .fetch_all(db)
    .await
}

pub async fn set_state(
    db: impl PgExecutor<'_>,
    track_id: i64,
    state: PinState,
    error: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE pinned_tracks SET state = $2, error = $3, updated_at = now() WHERE track_id = $1",
    )
    .bind(track_id)
    .bind(state)
    .bind(error)
    .execute(db)
    .await?;
    Ok(())
}

/// Возвращает закрепление в очередь (сменился primary-источник). Нет закрепления — ничего.
pub async fn requeue(db: impl PgExecutor<'_>, track_id: i64) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE pinned_tracks SET state = 'queued', error = NULL, updated_at = now()
         WHERE track_id = $1 AND state <> 'waiting_source'",
    )
    .bind(track_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Старт процесса: `downloading` → `queued` (движок восстановит торренты, менеджер повторит `ensure_files`).
pub async fn requeue_downloading(db: impl PgExecutor<'_>) -> sqlx::Result<u64> {
    let r = sqlx::query(
        "UPDATE pinned_tracks SET state = 'queued', updated_at = now() WHERE state = 'downloading'",
    )
    .execute(db)
    .await?;
    Ok(r.rows_affected())
}

/// Авто-повтор `failed`: старше `after_secs` секунд и не больше `max_retries` повторов.
pub async fn retry_failed(
    db: impl PgExecutor<'_>,
    after_secs: f64,
    max_retries: i32,
) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "UPDATE pinned_tracks SET state = 'queued', error = NULL, retries = retries + 1, updated_at = now()
         WHERE state = 'failed' AND retries < $2
           AND updated_at <= now() - make_interval(secs => $1)
         RETURNING track_id",
    )
    .bind(after_secs)
    .bind(max_retries)
    .fetch_all(db)
    .await
}

/// Сколько закреплений в каждом состоянии.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    pub queued: i64,
    pub downloading: i64,
    pub waiting_source: i64,
    pub failed: i64,
}

pub async fn counts(db: impl PgExecutor<'_>) -> sqlx::Result<Counts> {
    let rows: Vec<(PinState, i64)> =
        sqlx::query_as("SELECT state, count(*) FROM pinned_tracks GROUP BY state")
            .fetch_all(db)
            .await?;
    let mut c = Counts::default();
    for (s, n) in rows {
        match s {
            PinState::Queued => c.queued = n,
            PinState::Downloading => c.downloading = n,
            PinState::WaitingSource => c.waiting_source = n,
            PinState::Failed => c.failed = n,
            PinState::Done => {}
        }
    }
    Ok(c)
}

/// Файлы `(torrent_id, file_index)`, которые являются primary-источником закреплённого трека.
pub async fn protected_files(db: impl PgExecutor<'_>) -> sqlx::Result<HashSet<(i64, i32)>> {
    let rows: Vec<(i64, i32)> = sqlx::query_as(
        "SELECT DISTINCT ts.torrent_id, ts.file_index
         FROM pinned_tracks p JOIN track_sources ts ON ts.track_id = p.track_id AND ts.is_primary",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Нужен ли файл какому-либо закреплённому треку (как primary-источник).
pub async fn file_is_pinned(
    db: impl PgExecutor<'_>,
    torrent_id: i64,
    file_index: i32,
) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (
            SELECT 1 FROM pinned_tracks p JOIN track_sources ts ON ts.track_id = p.track_id AND ts.is_primary
            WHERE ts.torrent_id = $1 AND ts.file_index = $2)",
    )
    .bind(torrent_id)
    .bind(file_index)
    .fetch_one(db)
    .await
}

/// Закрепление трека (для тестов и API).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Pin {
    pub track_id: i64,
    pub album_pin: bool,
    pub state: PinState,
    pub error: Option<String>,
    pub retries: i32,
}

pub async fn get(db: impl PgExecutor<'_>, track_id: i64) -> sqlx::Result<Option<Pin>> {
    sqlx::query_as(
        "SELECT track_id, album_pin, state, error, retries FROM pinned_tracks WHERE track_id = $1",
    )
    .bind(track_id)
    .fetch_optional(db)
    .await
}

/// Основные источники закреплённых треков, привязанных к альбому/треку: файл для `unpin(delete_files)`.
pub async fn primary_files_of_tracks(
    db: impl PgExecutor<'_>,
    track_ids: &[i64],
) -> sqlx::Result<Vec<(i64, i32)>> {
    sqlx::query_as(
        "SELECT DISTINCT ts.torrent_id, ts.file_index FROM track_sources ts
         WHERE ts.is_primary AND ts.track_id = ANY($1)",
    )
    .bind(track_ids)
    .fetch_all(db)
    .await
}
