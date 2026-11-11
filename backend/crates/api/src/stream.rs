//! `GET /api/tracks/{id}/stream`: отдача аудио с поддержкой Range (с диска или из торрент-движка),
//! наблюдатель прогресса загрузок и статус `ready`.

use std::collections::HashMap;
use std::path::Path as FsPath;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
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

/// `Ok(mime)` для форматов, которые играет браузер; `Err` — нужно перекодирование (шаг 21).
pub fn content_type(ext: &str) -> Result<&'static str, ApiError> {
    Ok(match ext {
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" | "alac" => "audio/mp4",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        _ => {
            return Err(ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "transcode_required",
                format!("format .{ext} needs transcoding, which is not available yet"),
            ))
        }
    })
}

fn err(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, code, msg)
}

// ------------------------------------------------------------- обработчик

#[utoipa::path(
    get,
    path = "/api/tracks/{id}/stream",
    tag = "library",
    params(("id" = i64, Path, description = "ID трека")),
    responses(
        (status = 200, description = "Аудио целиком (`audio/*`)"),
        (status = 206, description = "Часть аудио по заголовку Range"),
        (status = 404, description = "Нет такого трека", body = crate::error::ErrorResponse),
        (status = 409, description = "Трек не `found`/`ready` (`track_not_playable`)", body = crate::error::ErrorResponse),
        (status = 415, description = "Формат требует перекодирования (`transcode_required`)", body = crate::error::ErrorResponse),
        (status = 416, description = "Диапазон вне файла", body = crate::error::ErrorResponse),
        (status = 501, description = "CUE-образ (`cue_not_supported`)", body = crate::error::ErrorResponse),
        (status = 504, description = "Нет пиров: данные не пришли вовремя (`no_peers`)", body = crate::error::ErrorResponse),
    )
)]
pub async fn stream_track(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Path(id): Path<i64>,
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
    if source.cue_start_ms.is_some() {
        return Err(err(
            StatusCode::NOT_IMPLEMENTED,
            "cue_not_supported",
            "CUE images are not supported yet",
        ));
    }

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
    let mime = content_type(&ext)?;
    let size = file.size_bytes.max(0) as u64;

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

    let reader = open_reader(&state, &torrent.magnet, &source, size).await?;
    downloads::touch_played(&state.db, source.torrent_id, source.file_index).await?;
    let body = body_from(&state, &track, &source, reader, start, len).await?;
    builder.body(body).map_err(|_| ApiError::internal())
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

fn map_engine_error(e: EngineError) -> ApiError {
    match e {
        EngineError::MetadataTimeout => err(
            StatusCode::GATEWAY_TIMEOUT,
            "no_peers",
            "no peers: torrent metadata was not received in time",
        ),
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
    track: &nimbus_core::model::Track,
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
            tracing::warn!(track_id = track.id, error = %e, "stream read failed");
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
    fn content_types() {
        assert_eq!(content_type("flac").unwrap(), "audio/flac");
        assert_eq!(content_type("mp3").unwrap(), "audio/mpeg");
        assert_eq!(content_type("m4a").unwrap(), "audio/mp4");
        assert_eq!(content_type("opus").unwrap(), "audio/ogg");
        assert_eq!(content_type("wav").unwrap(), "audio/wav");
        for e in ["ape", "wv", "dsf", "dff", "aiff", ""] {
            assert_eq!(
                content_type(e).unwrap_err().status,
                StatusCode::UNSUPPORTED_MEDIA_TYPE
            );
        }
    }
}
