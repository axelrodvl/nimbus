//! Перекодирование на лету через `ffmpeg`: CUE-образы (отрезок образа) и форматы, которые не играет браузер.

use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::{Body, Bytes};
use axum::http::{header, Method, StatusCode};
use axum::response::Response;
use futures::Stream;
use nimbus_core::model::{Torrent, Track, TrackSource};
use nimbus_db::repo::downloads;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::io::ReaderStream;

use crate::error::ApiError;
use crate::state::AppState;

/// Сколько процессов `ffmpeg` работает одновременно.
pub const MAX_PROCESSES: usize = 4;
const CHUNK: usize = 64 * 1024;

pub const H_TRANSCODE: &str = "x-nimbus-transcode";
pub const H_DURATION: &str = "x-nimbus-duration-ms";

#[derive(Clone)]
pub struct Transcoder {
    /// Команда или путь к `ffmpeg`.
    pub ffmpeg: String,
    /// Найден ли `ffmpeg` (проверяется при старте).
    pub available: bool,
    pub limit: Arc<Semaphore>,
    /// База локального адреса бэкенда (`http://127.0.0.1:PORT`) для чтения сырых файлов из торрента.
    pub raw_base: Option<String>,
}

impl Transcoder {
    pub fn new(ffmpeg: impl Into<String>) -> Self {
        Self {
            ffmpeg: ffmpeg.into(),
            available: false,
            limit: Arc::new(Semaphore::new(MAX_PROCESSES)),
            raw_base: None,
        }
    }

    /// Запускает `ffmpeg -version` и запоминает результат.
    pub async fn probe(mut self) -> Self {
        self.available = Command::new(&self.ffmpeg)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if !self.available {
            tracing::warn!(
                ffmpeg = %self.ffmpeg,
                "ffmpeg not found: CUE images and APE/WV/DSD/AIFF tracks cannot be played"
            );
        }
        self
    }

    pub fn with_raw_base(mut self, base: impl Into<String>) -> Self {
        self.raw_base = Some(base.into());
        self
    }

    pub fn with_available(mut self, available: bool) -> Self {
        self.available = available;
        self
    }
}

/// Аргументы `ffmpeg`: отрезок `[start, start + dur)` входа → FLAC в stdout.
pub fn ffmpeg_args(input: &str, start_s: f64, dur_s: Option<f64>) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin"]
        .map(String::from)
        .into();
    a.extend([
        "-ss".into(),
        format!("{start_s:.3}"),
        "-i".into(),
        input.into(),
    ]);
    if let Some(d) = dur_s {
        a.extend(["-t".into(), format!("{d:.3}")]);
    }
    a.extend(
        [
            "-map", "0:a:0", "-vn", "-c:a", "flac", "-f", "flac", "pipe:1",
        ]
        .map(String::from),
    );
    a
}

/// Длительность трека в мс: по CUE, иначе из БД.
pub fn duration_ms(track: &Track, source: &TrackSource) -> Option<i64> {
    match (source.cue_start_ms, source.cue_end_ms) {
        (Some(s), Some(e)) if e > s => Some((e - s) as i64),
        _ => track.duration_ms.map(i64::from),
    }
}

/// Поток stdout `ffmpeg`; пока он жив — живы процесс (убивается при drop) и слот лимита.
struct FfmpegStream {
    inner: ReaderStream<ChildStdout>,
    _child: Child,
    _permit: OwnedSemaphorePermit,
    _activity: nimbus_core::activity::StreamGuard,
}

impl Stream for FfmpegStream {
    type Item = std::io::Result<Bytes>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner).poll_next(cx)
    }
}

fn err(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, code, msg)
}

/// Ответ `200 audio/flac` с перекодированным треком (или `HEAD` без тела).
pub async fn transcode_response(
    state: &AppState,
    method: &Method,
    track: &Track,
    source: &TrackSource,
    torrent: &Torrent,
    size: u64,
    t: Option<f64>,
) -> Result<Response, ApiError> {
    let tc = &state.transcoder;
    if !tc.available {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "ffmpeg_missing",
            "ffmpeg is not installed on the server",
        ));
    }
    let offset = t.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
    let total_ms = duration_ms(track, source);

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, "audio/flac")
        .header(header::ACCEPT_RANGES, "none")
        .header(header::CACHE_CONTROL, "no-store")
        .header(H_TRANSCODE, "1");
    if let Some(ms) = total_ms {
        builder = builder.header(H_DURATION, ms);
    }
    if method == Method::HEAD {
        return builder
            .body(Body::empty())
            .map_err(|_| ApiError::internal());
    }

    // Отрезок: начало CUE + смещение; длительность — до конца CUE-отрезка.
    let base_s = source.cue_start_ms.unwrap_or(0) as f64 / 1000.0;
    let dur_s = match (source.cue_start_ms, source.cue_end_ms) {
        (Some(s), Some(e)) => Some((e - s) as f64 / 1000.0 - offset),
        _ => None,
    };
    if dur_s.is_some_and(|d| d <= 0.0) {
        return builder
            .body(Body::empty())
            .map_err(|_| ApiError::internal());
    }

    let permit = tc.limit.clone().try_acquire_owned().map_err(|_| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "transcoder_busy",
            "too many concurrent transcodes",
        )
    })?;
    let activity = state
        .activity
        .begin_stream(source.torrent_id, source.file_index);
    let input = resolve_input(state, source, torrent, size).await?;

    let mut child = Command::new(&tc.ffmpeg)
        .args(ffmpeg_args(&input, base_s + offset, dur_s))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            tracing::error!(error = %e, "cannot start ffmpeg");
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "ffmpeg_missing",
                "cannot start ffmpeg",
            )
        })?;
    let mut stdout = child.stdout.take().ok_or_else(ApiError::internal)?;

    // Ждём первые байты: если ffmpeg сразу упал или данные не приходят, отвечаем ошибкой, а не пустым 200.
    let mut buf = vec![0u8; CHUNK];
    let n = match tokio::time::timeout(state.first_byte_timeout, stdout.read(&mut buf)).await {
        Ok(Ok(n)) => n,
        Ok(Err(e)) => {
            return Err(err(
                StatusCode::BAD_GATEWAY,
                "transcode_failed",
                e.to_string(),
            ))
        }
        Err(_) => {
            return Err(err(
                StatusCode::GATEWAY_TIMEOUT,
                "no_peers",
                "no data received in time (no peers?)",
            ))
        }
    };
    if n == 0 {
        return Err(err(
            StatusCode::BAD_GATEWAY,
            "transcode_failed",
            "ffmpeg produced no output",
        ));
    }
    buf.truncate(n);
    let _ = downloads::touch_played(&state.db, source.torrent_id, source.file_index).await;

    let head = futures::stream::once(async move { Ok::<Bytes, std::io::Error>(Bytes::from(buf)) });
    let rest = FfmpegStream {
        inner: ReaderStream::with_capacity(stdout, CHUNK),
        _child: child,
        _permit: permit,
        _activity: activity,
    };
    builder
        .body(Body::from_stream(futures::StreamExt::chain(head, rest)))
        .map_err(|_| ApiError::internal())
}

/// Вход для `ffmpeg`: файл на диске (если докачан) или локальный Range-эндпоинт, читающий из движка.
async fn resolve_input(
    state: &AppState,
    source: &TrackSource,
    torrent: &Torrent,
    size: u64,
) -> Result<String, ApiError> {
    if let Some(path) = crate::stream::completed_local_path(state, source, size).await? {
        return Ok(path);
    }
    let base = state.transcoder.raw_base.as_ref().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "engine_unavailable",
            "torrent engine is not running",
        )
    })?;
    crate::stream::register_download(state, &torrent.magnet, source, size).await?;
    Ok(format!(
        "{base}/api/internal/raw/{}/{}",
        source.torrent_id, source.file_index
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_for_cue_segment() {
        let a = ffmpeg_args("/x/image.flac", 288.0, Some(282.493));
        let s = a.join(" ");
        assert!(s.contains("-ss 288.000 -i /x/image.flac -t 282.493 -map 0:a:0"));
        assert!(s.ends_with("-c:a flac -f flac pipe:1"));
    }

    #[test]
    fn args_without_duration_have_no_t() {
        let a = ffmpeg_args("in.wv", 0.0, None);
        assert!(!a.iter().any(|x| x == "-t"));
    }
}
