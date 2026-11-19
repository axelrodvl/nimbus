//! Синхронизация клиента (шаг 34): снимок библиотеки, дельта по курсору, сигнал `sync.poke`.
//!
//! Модель согласованности описана в `nimbus_db::repo::sync` и `docs/api.md` («Синхронизация»):
//! курсор — `xmin` снимка ответа, дельта — все строки с `sync_txid >= курсор`, поэтому изменения
//! параллельных транзакций не теряются (возможны только повторы, и клиентский upsert их переживёт).

use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use futures::StreamExt;
use nimbus_core::events::{Event, EventBus};
use nimbus_core::model::{PinState, TrackStatus};
use nimbus_db::repo::sync::{
    self, CursorError, Entity, Meta, SyncCursor, CHANGES_LIMIT, SYNC_SCHEMA,
};
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgListener;
use sqlx::{PgConnection, PgPool};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::error::{ApiError, ErrorResponse};
use crate::library::PlaybackMode;
use crate::state::AppState;

/// Не чаще одного события `sync.poke` за это окно (первое — сразу, остальные сливаются в одно).
pub const POKE_INTERVAL: Duration = Duration::from_millis(300);

/// Сколько снимок ждёт, пока клиент заберёт очередной кусок, прежде чем сдаться: зависший читатель
/// не должен держать транзакцию (а с ней `xmin` всей базы) бесконечно.
const SEND_STALL: Duration = Duration::from_secs(60);

/// Размер куска тела снимка: строки копятся в буфере и уходят пачками.
const CHUNK_BYTES: usize = 16 * 1024;

#[derive(Debug, Serialize, ToSchema)]
pub struct SyncArtist {
    pub id: i64,
    pub mbid: Uuid,
    pub name: String,
    pub sort_name: Option<String>,
    pub disambiguation: Option<String>,
    pub in_library: bool,
    pub added_at: Option<DateTime<Utc>>,
    /// Есть ли фото артиста: `yes` / `no`; `null` — ещё не искали (клиент запросит картинку сам).
    pub image: Option<String>,
    /// Состояние импорта дискографии: `queued` / `importing` / `retrying` / `failed`; `null` — не идёт.
    /// Меняется только на переходах задачи (не на прогрессе); детали — `GET /api/artists/{id}`.
    #[serde(rename = "import")]
    pub import_state: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SyncAlbum {
    pub id: i64,
    /// MBID release group.
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

#[derive(Debug, Serialize, ToSchema)]
pub struct SyncTrack {
    pub id: i64,
    pub mbid_recording: Uuid,
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
    /// Primary-источник сомнительный: его стоит проверить или подтвердить.
    pub needs_confirmation: bool,
    /// Как играть: `direct` или `transcode`.
    pub playback: PlaybackMode,
    pub play_count: i32,
    pub last_played_at: Option<DateTime<Utc>>,
    /// Закрепление трека на сервере (скачать и не вытеснять); `null` — не закреплён.
    pub pin: Option<PinState>,
    /// Причина `pin = failed` (например `stalled`).
    pub pin_error: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SyncPlaylist {
    pub id: i64,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SyncPlaylistTrack {
    pub id: i64,
    pub playlist_id: i64,
    pub track_id: i64,
    pub added_at: DateTime<Utc>,
}

impl From<sync::SyncArtist> for SyncArtist {
    fn from(r: sync::SyncArtist) -> Self {
        Self {
            id: r.id,
            mbid: r.mbid,
            name: r.name,
            sort_name: r.sort_name,
            disambiguation: r.disambiguation,
            in_library: r.in_library,
            added_at: r.added_at,
            image: r.image,
            import_state: r.import_state,
        }
    }
}

impl From<sync::SyncAlbum> for SyncAlbum {
    fn from(r: sync::SyncAlbum) -> Self {
        Self {
            id: r.id,
            mbid: r.mbid,
            artist_id: r.artist_id,
            title: r.title,
            year: r.year,
            primary_type: r.primary_type,
            secondary_types: r.secondary_types,
            cover_url: r.cover_url,
            in_library: r.in_library,
            added_at: r.added_at,
        }
    }
}

impl From<sync::SyncTrack> for SyncTrack {
    fn from(r: sync::SyncTrack) -> Self {
        Self {
            id: r.id,
            mbid_recording: r.mbid_recording,
            album_id: r.album_id,
            artist_id: r.artist_id,
            title: r.title,
            disc_no: r.disc_no,
            position: r.position,
            duration_ms: r.duration_ms,
            status: r.status,
            status_reason: r.status_reason,
            in_library: r.in_library,
            added_at: r.added_at,
            needs_confirmation: r.needs_confirmation,
            playback: if r.transcode {
                PlaybackMode::Transcode
            } else {
                PlaybackMode::Direct
            },
            play_count: r.play_count,
            last_played_at: r.last_played_at,
            pin: r.pin,
            pin_error: r.pin_error,
        }
    }
}

impl From<sync::SyncPlaylist> for SyncPlaylist {
    fn from(r: sync::SyncPlaylist) -> Self {
        Self {
            id: r.id,
            name: r.name,
            created_at: r.created_at,
            last_used_at: r.last_used_at,
        }
    }
}

impl From<sync::SyncPlaylistTrack> for SyncPlaylistTrack {
    fn from(r: sync::SyncPlaylistTrack) -> Self {
        Self {
            id: r.id,
            playlist_id: r.playlist_id,
            track_id: r.track_id,
            added_at: r.added_at,
        }
    }
}

/// Маршруты `/api/sync/*` со сжатием ответов (gzip, br). Сжатие включено только здесь: аудиостримы
/// сжимать нельзя (Range, уже сжатые данные).
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/snapshot", get(snapshot))
        .route("/changes", get(changes))
        .layer(tower_http::compression::CompressionLayer::new())
}

/// Счётчик живых задач-источников снимков: растёт при старте, падает при завершении (в том числе
/// когда клиент закрыл соединение). Нужен для тестов и диагностики утечек.
struct ActiveGuard(Arc<AtomicUsize>);

impl ActiveGuard {
    fn new(counter: &Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter.clone())
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Serialize)]
struct Line<'a, T: Serialize> {
    r#type: &'a str,
    row: &'a T,
}

#[derive(Serialize)]
struct Begin<'a> {
    r#type: &'static str,
    cursor: &'a str,
    schema: i32,
}

#[derive(Debug, Default, Serialize)]
struct Counts {
    artists: u64,
    albums: u64,
    tracks: u64,
    playlists: u64,
    playlist_tracks: u64,
}

#[derive(Serialize)]
struct End<'a> {
    r#type: &'static str,
    counts: &'a Counts,
}

/// Почему запись снимка остановилась.
enum Stop {
    /// Клиент ушёл или перестал читать — это штатно, ошибки нет.
    ClientGone,
    Db(sqlx::Error),
    Json(serde_json::Error),
}

impl From<sqlx::Error> for Stop {
    fn from(e: sqlx::Error) -> Self {
        Stop::Db(e)
    }
}

/// Копит NDJSON-строки и отправляет их пачками в тело ответа.
struct LineWriter {
    buf: Vec<u8>,
    out: mpsc::Sender<Result<Bytes, io::Error>>,
}

impl LineWriter {
    fn push<T: Serialize>(&mut self, value: &T) -> Result<(), Stop> {
        serde_json::to_writer(&mut self.buf, value).map_err(Stop::Json)?;
        self.buf.push(b'\n');
        Ok(())
    }

    async fn flush_if_large(&mut self) -> Result<(), Stop> {
        if self.buf.len() >= CHUNK_BYTES {
            self.flush().await?;
        }
        Ok(())
    }

    async fn flush(&mut self) -> Result<(), Stop> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::take(&mut self.buf));
        match tokio::time::timeout(SEND_STALL, self.out.send(Ok(chunk))).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) | Err(_) => Err(Stop::ClientGone),
        }
    }
}

macro_rules! stream_entity {
    ($w:expr, $conn:expr, $fetch:path, $ty:literal, $dto:ty, $count:expr) => {{
        let mut rows = $fetch($conn);
        while let Some(row) = rows.next().await {
            let dto = <$dto>::from(row?);
            $w.push(&Line {
                r#type: $ty,
                row: &dto,
            })?;
            $count += 1;
            $w.flush_if_large().await?;
        }
    }};
}

async fn write_snapshot(
    conn: &mut PgConnection,
    cursor: &str,
    w: &mut LineWriter,
) -> Result<(), Stop> {
    w.push(&Begin {
        r#type: "begin",
        cursor,
        schema: SYNC_SCHEMA,
    })?;
    let mut counts = Counts::default();
    stream_entity!(
        w,
        &mut *conn,
        sync::artists,
        "artist",
        SyncArtist,
        counts.artists
    );
    stream_entity!(
        w,
        &mut *conn,
        sync::albums,
        "album",
        SyncAlbum,
        counts.albums
    );
    stream_entity!(
        w,
        &mut *conn,
        sync::tracks,
        "track",
        SyncTrack,
        counts.tracks
    );
    stream_entity!(
        w,
        &mut *conn,
        sync::playlists,
        "playlist",
        SyncPlaylist,
        counts.playlists
    );
    stream_entity!(
        w,
        &mut *conn,
        sync::playlist_tracks,
        "playlist_track",
        SyncPlaylistTrack,
        counts.playlist_tracks
    );
    w.push(&End {
        r#type: "end",
        counts: &counts,
    })?;
    w.flush().await
}

#[utoipa::path(
    get,
    path = "/api/sync/snapshot",
    tag = "sync",
    responses((
        status = 200,
        content_type = "application/x-ndjson",
        description = "Весь синхронизируемый набор данных, по JSON-объекту в строке: `{\"type\":\"begin\",\"cursor\":\"…\",\"schema\":2}`, затем строки `artist`, `album`, `track`, `playlist`, `playlist_track` (`{\"type\":…,\"row\":{…}}`, именно в этом порядке сущностей), в конце `{\"type\":\"end\",\"counts\":{…}}`. Снимок принят, только если получена строка `end`; обрыв без неё — ошибка. Ответ сжимается (gzip, br).",
        body = String
    ))
)]
pub async fn snapshot(State(state): State<AppState>) -> Result<Response, ApiError> {
    let (mut tx, snap) = sync::begin_snapshot(&state.db).await?;
    let meta = sync::meta(&mut tx).await?;
    let cursor = SyncCursor {
        base: snap.xmin,
        after: None,
    }
    .encode(&meta.epoch);
    let (out, rx) = mpsc::channel::<Result<Bytes, io::Error>>(256);
    let guard = ActiveGuard::new(&state.sync_tasks);
    // Задача живёт, пока клиент читает ответ: закрытый приёмник, зависший читатель
    // (`SEND_STALL`) или конец данных завершают её, транзакция при этом откатывается.
    // В `JoinSet` не нужна: она не переживает запрос и сама освобождает соединение.
    tokio::spawn(async move {
        let _guard = guard;
        let mut w = LineWriter {
            buf: Vec::with_capacity(CHUNK_BYTES * 2),
            out,
        };
        let res = write_snapshot(&mut tx, &cursor, &mut w).await;
        // Транзакция только читает: откат — то же, что коммит, и не требует успеха.
        if let Err(e) = tx.rollback().await {
            tracing::debug!(error = %e, "snapshot transaction rollback failed");
        }
        let reason = match res {
            Ok(()) => return,
            Err(Stop::ClientGone) => {
                tracing::debug!("sync snapshot client went away");
                return;
            }
            Err(Stop::Db(e)) => e.to_string(),
            Err(Stop::Json(e)) => e.to_string(),
        };
        tracing::error!(error = %reason, "sync snapshot aborted");
        // Ошибка в теле, а не чистый конец: клиент не должен принять обрыв за полный снимок.
        let _ = w
            .out
            .send(Err(io::Error::other(
                "snapshot aborted by a database error",
            )))
            .await;
    });
    // `fuse`: слой сжатия может опросить поток ещё раз после конца, а `unfold` этого не допускает.
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    })
    .fuse();
    let mut res = Response::new(Body::from_stream(stream));
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson"),
    );
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ChangesQuery {
    /// Курсор из предыдущего ответа (`begin` снимка или `cursor` дельты). Непрозрачная строка.
    cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DeletedRef {
    /// `artist` | `album` | `track` | `playlist` | `playlist_track`.
    pub entity: String,
    pub id: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ChangesResponse {
    /// Курсор для следующего запроса. При `reset` пуст.
    pub cursor: String,
    /// Курсор не годится (неразборчив, другая база или версия формата, слишком старый): остальные
    /// поля пусты, клиент обязан взять `GET /api/sync/snapshot` заново.
    pub reset: bool,
    pub artists: Vec<SyncArtist>,
    pub albums: Vec<SyncAlbum>,
    pub tracks: Vec<SyncTrack>,
    pub playlists: Vec<SyncPlaylist>,
    pub playlist_tracks: Vec<SyncPlaylistTrack>,
    /// Удалённые строки. Строка и её надгробие в одном ответе не встречаются.
    pub deleted: Vec<DeletedRef>,
    /// Изменений больше лимита ответа (5000 строк): запросите ещё с возвращённым `cursor`.
    pub more: bool,
}

impl ChangesResponse {
    fn reset() -> Self {
        Self {
            cursor: String::new(),
            reset: true,
            artists: vec![],
            albums: vec![],
            tracks: vec![],
            playlists: vec![],
            playlist_tracks: vec![],
            deleted: vec![],
            more: false,
        }
    }
}

/// Курсор годится, только если он разбирается, относится к этой базе и лежит в допустимых границах:
/// не ниже `floor` (иначе надгробия могли быть вычищены) и не выше следующего номера транзакции
/// (иначе база откатилась, например восстановлением из копии).
fn cursor_usable(raw: &str, meta: &Meta, xmax: i64) -> Option<SyncCursor> {
    match SyncCursor::parse(raw, &meta.epoch) {
        Ok(c) if c.base >= meta.floor && c.base <= xmax => Some(c),
        Ok(_) | Err(CursorError::Malformed | CursorError::Foreign) => None,
    }
}

#[utoipa::path(
    get,
    path = "/api/sync/changes",
    tag = "sync",
    params(ChangesQuery),
    responses(
        (status = 200, description = "Изменения после курсора (не больше 5000 строк с надгробиями, по возрастанию `(sync_txid, сущность, id)`). Может повторять уже известные строки — клиент делает upsert, но изменений не теряет. Ответ сжимается (gzip, br).", body = ChangesResponse),
        (status = 400, description = "Параметр `cursor` не указан (`invalid_cursor`)", body = ErrorResponse),
        (status = 401, description = "Нужен токен", body = ErrorResponse),
    )
)]
pub async fn changes(
    State(state): State<AppState>,
    Query(q): Query<ChangesQuery>,
) -> Result<Json<ChangesResponse>, ApiError> {
    let raw = q.cursor.ok_or_else(|| {
        ApiError::bad_request("invalid_cursor", "query parameter `cursor` is required")
    })?;
    let (mut tx, snap) = sync::begin_snapshot(&state.db).await?;
    let result = changes_in(&mut tx, &raw, snap.xmin, snap.xmax).await;
    // Транзакция только читает: откат — то же, что коммит.
    if let Err(e) = tx.rollback().await {
        tracing::debug!(error = %e, "changes transaction rollback failed");
    }
    Ok(Json(result?))
}

async fn changes_in(
    conn: &mut PgConnection,
    raw: &str,
    xmin: i64,
    xmax: i64,
) -> sqlx::Result<ChangesResponse> {
    let meta = sync::meta(conn).await?;
    let Some(cursor) = cursor_usable(raw, &meta, xmax) else {
        return Ok(ChangesResponse::reset());
    };
    let ch = sync::changes_since(conn, &cursor, CHANGES_LIMIT).await?;
    // База серии страниц — `xmin` снимка её первой страницы (см. `SyncCursor`).
    let base = if cursor.after.is_some() {
        cursor.base
    } else {
        xmin
    };
    let next = SyncCursor {
        base,
        after: if ch.more { ch.last } else { None },
    };
    Ok(ChangesResponse {
        cursor: next.encode(&meta.epoch),
        reset: false,
        artists: ch.artists.into_iter().map(Into::into).collect(),
        albums: ch.albums.into_iter().map(Into::into).collect(),
        tracks: ch.tracks.into_iter().map(Into::into).collect(),
        playlists: ch.playlists.into_iter().map(Into::into).collect(),
        playlist_tracks: ch.playlist_tracks.into_iter().map(Into::into).collect(),
        deleted: ch
            .deleted
            .into_iter()
            .map(|(e, id): (Entity, i64)| DeletedRef {
                entity: e.as_str().into(),
                id,
            })
            .collect(),
        more: ch.more,
    })
}

/// Запускает слушателя `LISTEN nimbus_sync` под супервизором: изменения синхронизируемых таблиц
/// превращаются в события `sync.poke` (не чаще раза в [`POKE_INTERVAL`]). При разрыве соединения
/// слушатель переподключается и публикует один `sync.poke`: уведомления могли быть пропущены.
/// Завершается по `cancel`; задачу ждёт вызывающий.
pub fn spawn_sync_poker(
    pool: PgPool,
    events: EventBus,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    spawn_sync_poker_with(pool, events, cancel, POKE_INTERVAL, Duration::from_secs(2))
}

pub fn spawn_sync_poker_with(
    pool: PgPool,
    events: EventBus,
    cancel: CancellationToken,
    interval: Duration,
    retry_pause: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // Сигнал на одну ячейку: переполнение означает «уже есть необработанное изменение».
        let (signal, rx) = mpsc::channel::<()>(1);
        // Слушатель и коалесцер — отдельные циклы: чтение из сокета нельзя прерывать таймером
        // (полу-прочитанное сообщение потерялось бы), поэтому обрывается только всё сразу при остановке.
        tokio::select! {
            () = cancel.cancelled() => {}
            () = listen_loop(pool, signal, retry_pause) => {}
            () = coalesce_loop(rx, events, interval) => {}
        }
    })
}

/// Читает уведомления; при разрыве сам переподключается (`sqlx` возвращает `None`) и сигналит.
async fn listen_loop(pool: PgPool, signal: mpsc::Sender<()>, retry_pause: Duration) {
    let mut connected_before = false;
    loop {
        let mut listener = match PgListener::connect_with(&pool).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(error = %e, "sync listener cannot connect");
                tokio::time::sleep(retry_pause).await;
                continue;
            }
        };
        if let Err(e) = listener.listen("nimbus_sync").await {
            tracing::warn!(error = %e, "sync listener cannot LISTEN");
            tokio::time::sleep(retry_pause).await;
            continue;
        }
        if connected_before {
            // Между разрывом и новым LISTEN могли прийти уведомления.
            let _ = signal.try_send(());
        }
        connected_before = true;
        loop {
            match listener.try_recv().await {
                Ok(Some(_)) => {
                    let _ = signal.try_send(());
                }
                Ok(None) => {
                    tracing::warn!("sync listener connection lost, reconnected");
                    let _ = signal.try_send(());
                }
                Err(e) => {
                    tracing::warn!(error = %e, "sync listener failed, reconnecting");
                    tokio::time::sleep(retry_pause).await;
                    break;
                }
            }
        }
    }
}

/// Первое событие — сразу, дальше не чаще одного за `interval`; изменения, пришедшие внутри окна,
/// сливаются в одно замыкающее событие.
async fn coalesce_loop(mut rx: mpsc::Receiver<()>, events: EventBus, interval: Duration) {
    let mut last: Option<Instant> = None;
    while rx.recv().await.is_some() {
        if let Some(t) = last {
            tokio::time::sleep_until(t + interval).await;
        }
        // Всё, что пришло до этого момента, покрывается публикуемым событием.
        while rx.try_recv().is_ok() {}
        last = Some(Instant::now());
        events.publish(Event::SyncPoke);
    }
}
