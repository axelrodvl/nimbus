//! `GET /api/tracks/{id}/stream`: отдача аудио с поддержкой Range (с диска или из торрент-движка),
//! наблюдатель прогресса загрузок и статус `ready`.

use std::collections::HashMap;
use std::path::Path as FsPath;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use nimbus_core::events::Event;
use nimbus_core::model::{InfoHash, NewDownload, TrackSource, TrackStatus};
use nimbus_db::helpers::set_track_status_and_publish;
use nimbus_db::repo::{downloads, torrents, track_sources, tracks};
use nimbus_torrent::{AsyncReadSeek, EngineError, TorrentHandleId};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::auth::authorize;
use crate::error::ApiError;
use crate::state::AppState;

/// Размер буфера чтения при отдаче.
const CHUNK: usize = 64 * 1024;

// ------------------------------------------------------------------ Range

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeSpec {
    /// Заголовка нет (или неизвестная единица) — отдаём файл целиком.
    Full,
    /// Включительно `start..=end`.
    Partial { start: u64, end: u64 },
    /// `416 Range Not Satisfiable`.
    Unsatisfiable,
}

/// Разбор `Range: bytes=N-`, `N-M`, `-S`. Несколько диапазонов — берём первый.
pub fn parse_range(header: Option<&str>, size: u64) -> RangeSpec {
    let Some(h) = header.map(str::trim) else {
        return RangeSpec::Full;
    };
    let Some((unit, spec)) = h.split_once('=') else {
        return RangeSpec::Unsatisfiable;
    };
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return RangeSpec::Full;
    }
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = first.split_once('-') else {
        return RangeSpec::Unsatisfiable;
    };
    let (a, b) = (a.trim(), b.trim());
    if size == 0 {
        return RangeSpec::Unsatisfiable;
    }
    let num = |s: &str| s.parse::<u64>().ok();
    match (a.is_empty(), b.is_empty()) {
        // `-S`: последние S байт
        (true, false) => match num(b) {
            Some(0) | None => RangeSpec::Unsatisfiable,
            Some(s) => RangeSpec::Partial {
                start: size.saturating_sub(s),
                end: size - 1,
            },
        },
        // `N-`
        (false, true) => match num(a) {
            Some(start) if start < size => RangeSpec::Partial {
                start,
                end: size - 1,
            },
            _ => RangeSpec::Unsatisfiable,
        },
        // `N-M`
        (false, false) => match (num(a), num(b)) {
            (Some(start), Some(end)) if start <= end && start < size => RangeSpec::Partial {
                start,
                end: end.min(size - 1),
            },
            _ => RangeSpec::Unsatisfiable,
        },
        (true, true) => RangeSpec::Unsatisfiable,
    }
}

// ---------------------------------------------------------- Content-Type

/// MIME для форматов, которые играет браузер; `None` — нужно перекодирование (`transcode`).
pub fn direct_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" | "alac" => "audio/mp4",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        _ => return None,
    })
}

fn err(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, code, msg)
}

// ------------------------------------------------------------- обработчик

#[derive(Debug, serde::Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct StreamQuery {
    /// Только для перекодируемых треков: начать с этой секунды (перемотка).
    pub t: Option<f64>,
}

#[utoipa::path(
    get,
    path = "/api/tracks/{id}/stream",
    tag = "library",
    params(("id" = i64, Path, description = "ID трека"), StreamQuery),
    responses(
        (status = 200, description = "Аудио целиком (`audio/*`); для перекодируемых треков — `audio/flac` без Range (`X-Nimbus-Transcode: 1`, `X-Nimbus-Duration-Ms`)"),
        (status = 206, description = "Часть аудио по заголовку Range (только прямая отдача)"),
        (status = 404, description = "Нет такого трека", body = crate::error::ErrorResponse),
        (status = 409, description = "Трек не `found`/`ready` (`track_not_playable`)", body = crate::error::ErrorResponse),
        (status = 416, description = "Диапазон вне файла", body = crate::error::ErrorResponse),
        (status = 503, description = "Нет ffmpeg (`ffmpeg_missing`) или слишком много перекодирований (`transcoder_busy`)", body = crate::error::ErrorResponse),
        (status = 504, description = "Нет пиров: данные не пришли вовремя (`no_peers`)", body = crate::error::ErrorResponse),
    )
)]
pub async fn stream_track(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<StreamQuery>,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    let track = tracks::get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("track not found"))?;
    let playable = matches!(track.status, TrackStatus::Found | TrackStatus::Ready);
    let source = if playable {
        track_sources::primary_for_track(&state.db, id).await?
    } else {
        None
    };
    let Some(source) = source else {
        return Err(err(
            StatusCode::CONFLICT,
            "track_not_playable",
            format!("track is {}, no playable source", track.status.as_str()),
        ));
    };

    let torrent = torrents::get(&state.db, source.torrent_id)
        .await?
        .ok_or_else(ApiError::internal)?;
    let file = torrents::files(&state.db, source.torrent_id)
        .await?
        .into_iter()
        .find(|f| f.file_index == source.file_index)
        .ok_or_else(ApiError::internal)?;
    let ext = file
        .ext
        .clone()
        .or_else(|| {
            file.path
                .rsplit_once('.')
                .map(|(_, e)| e.to_ascii_lowercase())
        })
        .unwrap_or_default();
    let size = file.size_bytes.max(0) as u64;

    match direct_mime(&ext) {
        Some(mime) if source.cue_start_ms.is_none() => {
            serve_file(
                &state, &method, &headers, &torrent, &source, track.id, size, mime,
            )
            .await
        }
        _ => {
            crate::transcode::transcode_response(
                &state, &method, &track, &source, &torrent, size, q.t,
            )
            .await
        }
    }
}

/// Только для `ffmpeg` с этого же хоста: сырой файл раздачи с поддержкой Range.
pub async fn raw_file(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Path((torrent_id, file_index)): Path<(i64, i32)>,
    req: axum::extract::Request,
) -> Result<Response, ApiError> {
    if let Some(ci) = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
    {
        if !ci.0.ip().is_loopback() {
            return Err(err(StatusCode::FORBIDDEN, "forbidden", "loopback only"));
        }
    }
    let torrent = torrents::get(&state.db, torrent_id)
        .await?
        .ok_or_else(|| ApiError::not_found("torrent not found"))?;
    let file = torrents::files(&state.db, torrent_id)
        .await?
        .into_iter()
        .find(|f| f.file_index == file_index)
        .ok_or_else(|| ApiError::not_found("file not found"))?;
    // Источник нужен только как носитель (torrent, file_index); отказоустойчивость по трекам не применяется.
    let source = TrackSource {
        id: 0,
        track_id: 0,
        torrent_id,
        file_index,
        match_score: 1.0,
        is_primary: false,
        needs_confirmation: false,
        cue_start_ms: None,
        cue_end_ms: None,
        created_at: chrono::Utc::now(),
    };
    serve_file(
        &state,
        &method,
        &headers,
        &torrent,
        &source,
        0,
        file.size_bytes.max(0) as u64,
        "application/octet-stream",
    )
    .await
}

/// Отдача файла раздачи с Range (с диска или из движка).
#[allow(clippy::too_many_arguments)]
async fn serve_file(
    state: &AppState,
    method: &Method,
    headers: &HeaderMap,
    torrent: &nimbus_core::model::Torrent,
    source: &TrackSource,
    track_id: i64,
    size: u64,
    mime: &'static str,
) -> Result<Response, ApiError> {
    let range = parse_range(
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        size,
    );
    if range == RangeSpec::Unsatisfiable {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
        r.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes */{size}")).expect("ascii"),
        );
        return Ok(r);
    }
    let (start, end, partial) = match range {
        RangeSpec::Partial { start, end } => (start, end, true),
        _ => (0, size.saturating_sub(1), false),
    };
    let len = if size == 0 { 0 } else { end - start + 1 };

    let mut builder = Response::builder()
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, len);
    if partial {
        builder = builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }

    if method == Method::HEAD {
        return builder
            .body(Body::empty())
            .map_err(|_| ApiError::internal());
    }

    let guard = state
        .activity
        .begin_stream(source.torrent_id, source.file_index);
    let reader = open_reader(state, &torrent.magnet, source, size).await?;
    downloads::touch_played(&state.db, source.torrent_id, source.file_index).await?;
    let body = body_from(state, track_id, source, reader, start, len).await?;
    let body = Body::from_stream(Guarded {
        inner: body.into_data_stream(),
        _guard: guard,
    });
    builder.body(body).map_err(|_| ApiError::internal())
}

/// Путь к файлу на диске, если загрузка завершена и файл на месте нужного размера.
pub(crate) async fn completed_local_path(
    state: &AppState,
    source: &TrackSource,
    size: u64,
) -> Result<Option<String>, ApiError> {
    let existing = downloads::get(&state.db, source.torrent_id, source.file_index).await?;
    if let Some(d) = existing.filter(|d| d.completed_at.is_some()) {
        if let Ok(meta) = tokio::fs::metadata(&d.local_path).await {
            if meta.len() == size {
                return Ok(Some(d.local_path));
            }
        }
    }
    Ok(None)
}

type Reader = Box<dyn AsyncReadSeek + Send + Unpin>;

/// Файл с диска, если загрузка завершена и файл на месте; иначе — поток из движка.
async fn open_reader(
    state: &AppState,
    magnet: &str,
    source: &TrackSource,
    size: u64,
) -> Result<Reader, ApiError> {
    let existing = downloads::get(&state.db, source.torrent_id, source.file_index).await?;
    if let Some(d) = &existing {
        if d.completed_at.is_some() {
            if let Ok(meta) = tokio::fs::metadata(&d.local_path).await {
                if meta.len() == size {
                    if let Ok(f) = tokio::fs::File::open(&d.local_path).await {
                        return Ok(Box::new(f));
                    }
                }
            }
        }
    }

    let files = state.files.as_ref().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "engine_unavailable",
            "torrent engine is not running",
        )
    })?;
    let idx = source.file_index as usize;
    let handle = match files.ensure_file(magnet, idx).await {
        Ok(h) => h,
        Err(e) => {
            failover(state, source).await;
            return Err(map_engine_error(e));
        }
    };
    if existing.is_none() {
        if let Some(path) = files.file_path(&handle, idx) {
            downloads::upsert(
                &state.db,
                &NewDownload {
                    torrent_id: source.torrent_id,
                    file_index: source.file_index,
                    local_path: path.to_string_lossy().into_owned(),
                    bytes_total: size as i64,
                    bytes_done: 0,
                },
            )
            .await?;
        }
    }
    files.open_stream(&handle, idx).await.map_err(|e| {
        tracing::warn!(error = %e, "open_stream failed");
        map_engine_error(e)
    })
}

pub(crate) fn map_engine_error(e: EngineError) -> ApiError {
    match e {
        EngineError::MetadataTimeout => err(
            StatusCode::GATEWAY_TIMEOUT,
            "no_peers",
            "no peers: torrent metadata was not received in time",
        ),
        EngineError::Storage(m) => err(StatusCode::INSUFFICIENT_STORAGE, "storage_error", m),
        other => err(StatusCode::BAD_GATEWAY, "torrent_error", other.to_string()),
    }
}

/// Нет пиров / источник не отвечает: следующий запрос пойдёт через другой источник
/// (внутри одного HTTP-ответа не переключаемся).
async fn failover(state: &AppState, current: &TrackSource) {
    let Ok(sources) = track_sources::list_for_track(&state.db, current.track_id).await else {
        return;
    };
    let next = sources
        .iter()
        .filter(|s| s.id != current.id && s.cue_start_ms.is_none())
        .min_by(|a, b| {
            a.needs_confirmation
                .cmp(&b.needs_confirmation)
                .then(b.match_score.total_cmp(&a.match_score))
                .then(a.id.cmp(&b.id))
        });
    if let Some(next) = next {
        tracing::warn!(
            track_id = current.track_id,
            from = current.id,
            to = next.id,
            "primary source is unavailable, switching for the next request"
        );
        let _ = track_sources::set_primary(&state.db, current.track_id, next.id).await;
    }
}

/// Позиционирует поток, ждёт первые байты (с таймаутом) и строит тело ответа.
async fn body_from(
    state: &AppState,
    track_id: i64,
    source: &TrackSource,
    mut reader: Reader,
    start: u64,
    len: u64,
) -> Result<Body, ApiError> {
    if len == 0 {
        return Ok(Body::empty());
    }
    let first = async {
        reader.seek(std::io::SeekFrom::Start(start)).await?;
        let mut limited = reader.take(len);
        let mut buf = vec![0u8; CHUNK.min(len as usize)];
        let n = limited.read(&mut buf).await?;
        buf.truncate(n);
        Ok::<_, std::io::Error>((limited, buf))
    };
    let (limited, buf) = match tokio::time::timeout(state.first_byte_timeout, first).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            tracing::warn!(track_id, error = %e, "stream read failed");
            return Err(err(StatusCode::BAD_GATEWAY, "stream_error", e.to_string()));
        }
        Err(_) => {
            failover(state, source).await;
            return Err(err(
                StatusCode::GATEWAY_TIMEOUT,
                "no_peers",
                "no data received in time (no peers?)",
            ));
        }
    };
    if buf.is_empty() {
        return Err(err(
            StatusCode::BAD_GATEWAY,
            "stream_error",
            "unexpected end of file",
        ));
    }
    let head = futures::stream::once(async move { Ok::<Bytes, std::io::Error>(Bytes::from(buf)) });
    let rest = ReaderStream::with_capacity(limited, CHUNK);
    Ok(Body::from_stream(futures::StreamExt::chain(head, rest)))
}

/// Тело ответа, которое держит запись об активном стриме (вытеснение кэша не трогает такой файл).
struct Guarded<S> {
    inner: S,
    _guard: nimbus_core::activity::StreamGuard,
}

impl<S: futures::Stream + Unpin> futures::Stream for Guarded<S> {
    type Item = S::Item;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.inner).poll_next(cx)
    }
}

/// Регистрирует файл в движке и строку `downloads` (если её ещё нет); возвращает handle торрента.
pub(crate) async fn register_download(
    state: &AppState,
    magnet: &str,
    source: &TrackSource,
    size: u64,
) -> Result<nimbus_torrent::TorrentHandleId, ApiError> {
    let files = state.files.as_ref().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "engine_unavailable",
            "torrent engine is not running",
        )
    })?;
    let idx = source.file_index as usize;
    let handle = files
        .ensure_file(magnet, idx)
        .await
        .map_err(map_engine_error)?;
    if downloads::get(&state.db, source.torrent_id, source.file_index)
        .await?
        .is_none()
    {
        if let Some(path) = files.file_path(&handle, idx) {
            downloads::upsert(
                &state.db,
                &NewDownload {
                    torrent_id: source.torrent_id,
                    file_index: source.file_index,
                    local_path: path.to_string_lossy().into_owned(),
                    bytes_total: size as i64,
                    bytes_done: 0,
                },
            )
            .await?;
        }
    }
    Ok(handle)
}

/// Сколько байт читаем при prefetch: ~10 % файла, но не больше 2 МБ.
pub const PREFETCH_MAX_BYTES: u64 = 2 * 1024 * 1024;

pub fn prefetch_len(size: u64) -> u64 {
    (size / 10).clamp(1, PREFETCH_MAX_BYTES).min(size.max(1))
}

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
pub struct PrefetchResponse {
    /// `started` — предзагрузка запущена, `ready` — файл уже на диске, `skipped` — нечего грузить.
    pub state: String,
}

#[utoipa::path(
    post,
    path = "/api/tracks/{id}/prefetch",
    tag = "library",
    params(("id" = i64, Path, description = "ID трека")),
    responses(
        (status = 202, description = "Предзагрузка начала файла запущена в фоне", body = PrefetchResponse),
        (status = 404, description = "Нет такого трека", body = crate::error::ErrorResponse),
    )
)]
pub async fn prefetch_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<(StatusCode, axum::Json<PrefetchResponse>), ApiError> {
    authorize(&state, &headers)?;
    let track = tracks::get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("track not found"))?;
    let respond = |s: &str| {
        (
            StatusCode::ACCEPTED,
            axum::Json(PrefetchResponse { state: s.into() }),
        )
    };
    let source = if track.status == TrackStatus::Found {
        track_sources::primary_for_track(&state.db, id).await?
    } else {
        None
    };
    let Some(source) = source else {
        return Ok(respond("skipped"));
    };
    let torrent = torrents::get(&state.db, source.torrent_id)
        .await?
        .ok_or_else(ApiError::internal)?;
    let size = torrents::files(&state.db, source.torrent_id)
        .await?
        .into_iter()
        .find(|f| f.file_index == source.file_index)
        .map(|f| f.size_bytes.max(0) as u64)
        .ok_or_else(ApiError::internal)?;
    if completed_local_path(&state, &source, size).await?.is_some() {
        return Ok(respond("ready"));
    }
    state
        .activity
        .mark_prefetched(source.torrent_id, source.file_index);
    let bg = state.clone();
    tokio::spawn(async move {
        if let Err(e) = prefetch_head(&bg, &torrent.magnet, &source, size).await {
            tracing::debug!(track_id = source.track_id, error = ?e.message, "prefetch failed");
        }
    });
    Ok(respond("started"))
}

/// Регистрирует файл в движке и читает его начало; файл продолжает докачиваться в фоне.
async fn prefetch_head(
    state: &AppState,
    magnet: &str,
    source: &TrackSource,
    size: u64,
) -> Result<(), ApiError> {
    let handle = register_download(state, magnet, source, size).await?;
    let files = state.files.as_ref().ok_or_else(ApiError::internal)?;
    let mut reader = files
        .open_stream(&handle, source.file_index as usize)
        .await
        .map_err(map_engine_error)?;
    let want = prefetch_len(size) as usize;
    let read = async {
        let mut buf = vec![0u8; CHUNK.min(want.max(1))];
        let mut total = 0usize;
        while total < want {
            let n = reader.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            total += n;
        }
        Ok::<_, std::io::Error>(total)
    };
    match tokio::time::timeout(state.first_byte_timeout, read).await {
        Ok(Ok(n)) => tracing::debug!(bytes = n, "prefetched"),
        Ok(Err(e)) => return Err(err(StatusCode::BAD_GATEWAY, "stream_error", e.to_string())),
        Err(_) => {
            return Err(err(
                StatusCode::GATEWAY_TIMEOUT,
                "no_peers",
                "prefetch timed out",
            ))
        }
    }
    Ok(())
}

// ------------------------------------------------------- наблюдатель

/// Состояние наблюдателя между тиками.
#[derive(Default)]
pub struct Watcher {
    last_bytes: HashMap<(i64, i32), u64>,
    last_db_write: HashMap<(i64, i32), Instant>,
    hashes: HashMap<i64, InfoHash>,
    /// Как часто писать `bytes_done` в БД.
    pub db_write_interval: Option<Duration>,
}

impl Watcher {
    pub fn new() -> Self {
        Self {
            db_write_interval: Some(Duration::from_secs(10)),
            ..Self::default()
        }
    }

    /// Один проход: прогресс всех незавершённых загрузок, события и переход в `ready`.
    pub async fn tick(&mut self, state: &AppState) -> Result<(), sqlx::Error> {
        let Some(files) = state.files.as_ref() else {
            return Ok(());
        };
        for d in downloads::list_active(&state.db).await? {
            let key = (d.torrent_id, d.file_index);
            let hash = match self.hashes.get(&d.torrent_id) {
                Some(h) => h.clone(),
                None => {
                    let Some(t) = torrents::get(&state.db, d.torrent_id).await? else {
                        continue;
                    };
                    let Ok(h) = InfoHash::parse(&t.info_hash) else {
                        continue;
                    };
                    self.hashes.insert(d.torrent_id, h.clone());
                    h
                }
            };
            let Some(p) = files.file_progress(&TorrentHandleId(hash), d.file_index as usize) else {
                continue;
            };
            let changed = self.last_bytes.insert(key, p.bytes_done) != Some(p.bytes_done);

            if changed {
                for track_id in
                    track_sources::track_ids_with_primary(&state.db, d.torrent_id, d.file_index)
                        .await?
                {
                    state.events.publish(Event::StreamProgress {
                        track_id,
                        bytes_done: p.bytes_done,
                        bytes_total: p.bytes_total,
                        peers: p.peers,
                        down_speed_bps: p.down_speed_bps,
                    });
                }
            }

            if p.finished {
                downloads::mark_completed(&state.db, d.torrent_id, d.file_index).await?;
                for t in track_sources::tracks_with_primary(
                    &state.db,
                    d.torrent_id,
                    d.file_index,
                    TrackStatus::Found,
                )
                .await?
                {
                    set_track_status_and_publish(
                        &state.db,
                        &state.events,
                        t.id,
                        TrackStatus::Ready,
                        None,
                    )
                    .await?;
                }
                // После завершения файла проверяем, не превышен ли лимит кэша.
                nimbus_db::repo::jobs::enqueue(
                    &state.db,
                    &nimbus_core::jobs::Job::EvictCache,
                    nimbus_db::repo::jobs::EnqueueOpts::priority(
                        nimbus_core::jobs::PRIORITY_BACKGROUND,
                    ),
                )
                .await?;
                self.last_bytes.remove(&key);
                self.last_db_write.remove(&key);
                tracing::info!(
                    torrent_id = d.torrent_id,
                    file = d.file_index,
                    "download completed"
                );
            } else if changed {
                let due = self.db_write_interval.is_none_or(|iv| {
                    self.last_db_write
                        .get(&key)
                        .is_none_or(|t| t.elapsed() >= iv)
                });
                if due {
                    downloads::update_progress(
                        &state.db,
                        d.torrent_id,
                        d.file_index,
                        p.bytes_done as i64,
                    )
                    .await?;
                    self.last_db_write.insert(key, Instant::now());
                }
            }
        }
        Ok(())
    }
}

/// Запускает наблюдатель (раз в секунду) в фоне.
pub fn spawn_watcher(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut w = Watcher::new();
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            if let Err(e) = w.tick(&state).await {
                tracing::warn!(error = %e, "download watcher tick failed");
            }
        }
    })
}

/// При старте: завершённые загрузки, файлов которых нет на диске, сбрасываются, треки `ready → found`.
pub async fn reconcile_downloads(state: &AppState) -> Result<usize, sqlx::Error> {
    let mut fixed = 0;
    for d in downloads::list_completed(&state.db).await? {
        if FsPath::new(&d.local_path).exists() {
            continue;
        }
        tracing::warn!(path = %d.local_path, "completed download is missing on disk, resetting");
        downloads::reset_completed(&state.db, d.torrent_id, d.file_index).await?;
        for t in track_sources::tracks_with_primary(
            &state.db,
            d.torrent_id,
            d.file_index,
            TrackStatus::Ready,
        )
        .await?
        {
            set_track_status_and_publish(&state.db, &state.events, t.id, TrackStatus::Found, None)
                .await?;
        }
        fixed += 1;
    }
    Ok(fixed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use RangeSpec::*;

    #[test]
    fn engine_errors_map_to_http_statuses() {
        let status = |e| map_engine_error(e).status;
        assert_eq!(
            status(EngineError::MetadataTimeout),
            StatusCode::GATEWAY_TIMEOUT
        );
        assert_eq!(
            status(EngineError::Storage("No space left on device".into())),
            StatusCode::INSUFFICIENT_STORAGE
        );
        assert_eq!(status(EngineError::NotFound), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn engine_errors_map_to_api_errors() {
        let e = map_engine_error(EngineError::Storage("No space left on device".into()));
        assert_eq!(
            (e.status, e.code.as_str()),
            (StatusCode::INSUFFICIENT_STORAGE, "storage_error")
        );
        let e = map_engine_error(EngineError::MetadataTimeout);
        assert_eq!(
            (e.status, e.code.as_str()),
            (StatusCode::GATEWAY_TIMEOUT, "no_peers")
        );
        let e = map_engine_error(EngineError::NotFound);
        assert_eq!(
            (e.status, e.code.as_str()),
            (StatusCode::BAD_GATEWAY, "torrent_error")
        );
    }

    #[test]
    fn range_forms() {
        let r = |h: &str, size| parse_range(Some(h), size);
        assert_eq!(parse_range(None, 100), Full);
        assert_eq!(r("bytes=0-", 100), Partial { start: 0, end: 99 });
        assert_eq!(r("bytes=10-", 100), Partial { start: 10, end: 99 });
        assert_eq!(r("bytes=10-19", 100), Partial { start: 10, end: 19 });
        assert_eq!(r("bytes=90-500", 100), Partial { start: 90, end: 99 });
        assert_eq!(r("bytes=-10", 100), Partial { start: 90, end: 99 });
        assert_eq!(r("bytes=-500", 100), Partial { start: 0, end: 99 });
        assert_eq!(r("bytes=99-99", 100), Partial { start: 99, end: 99 });
        // несколько диапазонов — первый
        assert_eq!(r("bytes=0-4, 10-14", 100), Partial { start: 0, end: 4 });
        assert_eq!(r(" Bytes = 5-6 ", 100), Partial { start: 5, end: 6 });
    }

    #[test]
    fn range_errors() {
        let r = |h: &str, size| parse_range(Some(h), size);
        assert_eq!(r("bytes=100-", 100), Unsatisfiable);
        assert_eq!(r("bytes=150-200", 100), Unsatisfiable);
        assert_eq!(r("bytes=20-10", 100), Unsatisfiable);
        assert_eq!(r("bytes=-0", 100), Unsatisfiable);
        assert_eq!(r("bytes=-", 100), Unsatisfiable);
        assert_eq!(r("bytes=abc-def", 100), Unsatisfiable);
        assert_eq!(r("bytes=5", 100), Unsatisfiable);
        assert_eq!(r("garbage", 100), Unsatisfiable);
        assert_eq!(r("bytes=0-", 0), Unsatisfiable);
        // неизвестная единица игнорируется
        assert_eq!(r("items=0-5", 100), Full);
    }

    #[test]
    fn direct_mimes() {
        assert_eq!(direct_mime("flac"), Some("audio/flac"));
        assert_eq!(direct_mime("mp3"), Some("audio/mpeg"));
        assert_eq!(direct_mime("m4a"), Some("audio/mp4"));
        assert_eq!(direct_mime("opus"), Some("audio/ogg"));
        assert_eq!(direct_mime("wav"), Some("audio/wav"));
        for e in ["ape", "wv", "dsf", "dff", "aiff", ""] {
            assert_eq!(direct_mime(e), None, "{e}");
        }
    }
}
