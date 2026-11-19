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
            next_retry_at = CASE WHEN pinned_tracks.state = 'failed' THEN NULL ELSE pinned_tracks.next_retry_at END,
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

/// Возвращает закрепление в очередь (сменился primary-источник): ошибка, счётчик повторов и
/// расписание обнуляются. Нет закрепления — ничего.
pub async fn requeue(db: impl PgExecutor<'_>, track_id: i64) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE pinned_tracks SET state = 'queued', error = NULL, retries = 0, next_retry_at = NULL,
                updated_at = now()
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

/// Закрепление не удалось: `failed` с причиной и расписанием. `next_retry_at = None` — повторов не будет
/// (окончательная неудача или `dead`); `count` — засчитать неудачу в `retries` (счётчик циклов «нет сидов»).
pub async fn fail(
    db: impl PgExecutor<'_>,
    track_id: i64,
    error: &str,
    next_retry_at: Option<chrono::DateTime<chrono::Utc>>,
    count: bool,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE pinned_tracks
         SET state = 'failed', error = $2, next_retry_at = $3, retries = retries + $4, updated_at = now()
         WHERE track_id = $1",
    )
    .bind(track_id)
    .bind(error)
    .bind(next_retry_at)
    .bind(i32::from(count))
    .execute(db)
    .await?;
    Ok(())
}

/// Авто-повтор `failed`: у кого наступил `next_retry_at`, возвращаются в очередь. `retries` не трогается —
/// это номер ступени расписания; обнуляет его прогресс загрузки ([`reset_retries`]).
pub async fn retry_failed(db: impl PgExecutor<'_>) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "UPDATE pinned_tracks SET state = 'queued', error = NULL, next_retry_at = NULL, updated_at = now()
         WHERE state = 'failed' AND next_retry_at <= now()
         RETURNING track_id",
    )
    .fetch_all(db)
    .await
}

/// Загрузка пошла: счётчик повторов обнуляется (один UPDATE, только если он был ненулевым).
pub async fn reset_retries(db: impl PgExecutor<'_>, track_id: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE pinned_tracks SET retries = 0 WHERE track_id = $1 AND retries > 0")
        .bind(track_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Задаёт счётчик повторов (после смены источника `requeue` его обнуляет, а цикл «нет сидов» должен копиться).
pub async fn set_retries(db: impl PgExecutor<'_>, track_id: i64, retries: i32) -> sqlx::Result<()> {
    sqlx::query("UPDATE pinned_tracks SET retries = $2 WHERE track_id = $1")
        .bind(track_id)
        .bind(retries)
        .execute(db)
        .await?;
    Ok(())
}

/// Закрепления `failed("stalled"|"dead")` среди `track_ids` возвращаются в очередь: у трека появился
/// новый источник. Возвращает id вернувшихся треков.
pub async fn requeue_stalled_for_tracks(
    db: impl PgExecutor<'_>,
    track_ids: &[i64],
) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "UPDATE pinned_tracks SET state = 'queued', error = NULL, retries = 0, next_retry_at = NULL,
                updated_at = now()
         WHERE track_id = ANY($1) AND state = 'failed' AND error IN ('stalled','dead')
         RETURNING track_id",
    )
    .bind(track_ids)
    .fetch_all(db)
    .await
}

/// Есть ли у альбома закрепление, источники которого мертвы (`failed` со `stalled`/`dead`): нужен новый поиск.
pub async fn album_needs_sources(db: impl PgExecutor<'_>, album_id: i64) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (
            SELECT 1 FROM pinned_tracks p JOIN tracks t ON t.id = p.track_id
            WHERE t.album_id = $1 AND p.state = 'failed' AND p.error IN ('stalled','dead'))",
    )
    .bind(album_id)
    .fetch_one(db)
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

/// Файлы, которые служат основным (primary) источником хоть одному треку библиотеки. Остальные — скачанное для
/// «просто послушать» и резервные источники, которыми библиотека не пользуется, — вытесняются из кэша первыми.
pub async fn library_files(db: impl PgExecutor<'_>) -> sqlx::Result<HashSet<(i64, i32)>> {
    let rows: Vec<(i64, i32)> = sqlx::query_as(
        "SELECT DISTINCT ts.torrent_id, ts.file_index
         FROM track_sources ts JOIN tracks t ON t.id = ts.track_id
         WHERE t.in_library AND ts.is_primary",
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
    pub next_retry_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn get(db: impl PgExecutor<'_>, track_id: i64) -> sqlx::Result<Option<Pin>> {
    sqlx::query_as(
        "SELECT track_id, album_pin, state, error, retries, next_retry_at FROM pinned_tracks WHERE track_id = $1",
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
