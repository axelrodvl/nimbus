//! Менеджер загрузок: список торрентов движка и ручная пауза / запуск.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use nimbus_core::events::{Entity, Event};
use nimbus_core::model::InfoHash;
use nimbus_db::repo::{albums, pins, torrent_upload, tracks};
use nimbus_torrent::{EngineError, TorrentEngine, TorrentHandleId, TorrentInfo, TorrentState};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::auth::authorize;
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    Initializing,
    Downloading,
    Seeding,
    Paused,
    Error,
}

impl From<TorrentState> for DownloadState {
    fn from(s: TorrentState) -> Self {
        match s {
            TorrentState::Initializing => Self::Initializing,
            TorrentState::Downloading => Self::Downloading,
            TorrentState::Seeding => Self::Seeding,
            TorrentState::Paused => Self::Paused,
            TorrentState::Error => Self::Error,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DownloadDto {
    /// Info-hash (hex, нижний регистр) — идентификатор торрента.
    pub info_hash: String,
    pub name: String,
    pub state: DownloadState,
    /// Причина ошибки (`state = error`).
    pub error: Option<String>,
    pub finished: bool,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    /// Отдано пирам за сессию.
    pub uploaded_bytes: u64,
    /// Отдано пирам за всё время (с учётом прошлых запусков сервера).
    pub uploaded_total_bytes: u64,
    pub down_bps: u64,
    pub up_bps: u64,
    /// Подключённые пиры (включая сидов).
    pub peers: u32,
    pub seeds: u32,
}

impl From<TorrentInfo> for DownloadDto {
    fn from(t: TorrentInfo) -> Self {
        Self {
            info_hash: t.info_hash.to_string(),
            name: t.name,
            state: t.state.into(),
            error: t.error,
            finished: t.finished,
            progress_bytes: t.progress_bytes,
            total_bytes: t.total_bytes,
            uploaded_bytes: t.uploaded_bytes,
            uploaded_total_bytes: t.uploaded_bytes,
            down_bps: t.down_bps,
            up_bps: t.up_bps,
            peers: t.peers,
            seeds: t.seeds,
        }
    }
}

/// Закрепления по состояниям (`done` не считается: их история — в `/api/acquisition`).
#[derive(Debug, Serialize, ToSchema)]
pub struct DownloadQueue {
    pub queued: i64,
    pub downloading: i64,
    pub waiting_source: i64,
    pub failed: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DownloadsResponse {
    pub torrents: Vec<DownloadDto>,
    pub down_bps: u64,
    pub up_bps: u64,
    /// Включена глобальная пауза закреплённых загрузок.
    pub paused: bool,
    pub queue: DownloadQueue,
}

fn engine(state: &AppState) -> Result<&TorrentEngine, ApiError> {
    state.engine.as_deref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "engine_unavailable",
            "torrent engine is not running",
        )
    })
}

#[utoipa::path(
    get,
    path = "/api/downloads",
    tag = "downloads",
    responses(
        (status = 200, description = "Торренты в сессии движка: статус, пиры, сиды, скорости", body = DownloadsResponse),
        (status = 503, description = "Торрент-движок не запущен", body = crate::error::ErrorResponse),
    )
)]
pub async fn list_downloads(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DownloadsResponse>, ApiError> {
    authorize(&state, &headers)?;
    let mut torrents: Vec<DownloadDto> = engine(&state)?
        .list_torrents()
        .into_iter()
        .map(Into::into)
        .collect();
    record_uploads(&state, &mut torrents).await;
    let q = pins::counts(&state.db).await?;
    Ok(Json(DownloadsResponse {
        down_bps: torrents.iter().map(|t| t.down_bps).sum(),
        up_bps: torrents.iter().map(|t| t.up_bps).sum(),
        torrents,
        paused: nimbus_db::settings::downloads_paused(&state.db).await?,
        queue: DownloadQueue {
            queued: q.queued,
            downloading: q.downloading,
            waiting_source: q.waiting_source,
            failed: q.failed,
        },
    }))
}

/// Сохраняет отдачу сессии и подставляет накопленную; при сбое БД остаётся значение сессии.
async fn record_uploads(state: &AppState, torrents: &mut [DownloadDto]) {
    let sessions: Vec<(String, u64)> = torrents
        .iter()
        .map(|t| (t.info_hash.clone(), t.uploaded_bytes))
        .collect();
    match torrent_upload::record(&state.db, &sessions).await {
        Ok(totals) => {
            for t in torrents {
                if let Some(total) = totals.get(&t.info_hash) {
                    t.uploaded_total_bytes = *total;
                }
            }
        }
        Err(e) => tracing::warn!(error = %e, "cannot record torrent uploads"),
    }
}

/// Раз в минуту сохраняет отдачу всех торрентов (иначе она копилась бы только при открытом экране «Загрузки»).
pub fn spawn_upload_recorder(
    state: AppState,
    cancel: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tokio::select! {
                () = cancel.cancelled() => break,
                _ = tick.tick() => {}
            }
            if let Some(engine) = state.engine.as_deref() {
                let mut all: Vec<DownloadDto> =
                    engine.list_torrents().into_iter().map(Into::into).collect();
                record_uploads(&state, &mut all).await;
            }
        }
    })
}

fn parse_id(raw: &str) -> Result<TorrentHandleId, ApiError> {
    InfoHash::parse(raw)
        .map(TorrentHandleId)
        .map_err(|e| ApiError::bad_request("invalid_info_hash", e.to_string()))
}

fn map_err(e: EngineError) -> ApiError {
    match e {
        EngineError::NotFound => ApiError::not_found("torrent not found"),
        EngineError::Storage(m) => {
            ApiError::new(StatusCode::INSUFFICIENT_STORAGE, "storage_error", m)
        }
        other => ApiError::new(StatusCode::BAD_GATEWAY, "torrent_error", other.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/downloads/{info_hash}/pause",
    tag = "downloads",
    params(("info_hash" = String, Path, description = "Info-hash торрента")),
    responses(
        (status = 204, description = "Торрент остановлен (идемпотентно)"),
        (status = 404, description = "Нет такого торрента", body = crate::error::ErrorResponse),
    )
)]
pub async fn pause_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(info_hash): Path<String>,
) -> Result<StatusCode, ApiError> {
    authorize(&state, &headers)?;
    engine(&state)?
        .pause_torrent(&parse_id(&info_hash)?)
        .await
        .map_err(map_err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/downloads/{info_hash}/resume",
    tag = "downloads",
    params(("info_hash" = String, Path, description = "Info-hash торрента")),
    responses(
        (status = 204, description = "Торрент запущен (идемпотентно)"),
        (status = 404, description = "Нет такого торрента", body = crate::error::ErrorResponse),
    )
)]
pub async fn resume_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(info_hash): Path<String>,
) -> Result<StatusCode, ApiError> {
    authorize(&state, &headers)?;
    engine(&state)?
        .resume_torrent(&parse_id(&info_hash)?)
        .await
        .map_err(map_err)?;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------ закрепление (шаг 33)

#[derive(Debug, Serialize, ToSchema)]
pub struct PinResponse {
    /// Сколько треков закреплено (уже закреплённые тоже считаются: операция идемпотентна).
    pub pinned: u32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PausedResponse {
    pub paused: bool,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct UnpinParams {
    /// Удалить скачанные файлы (кроме нужных другому закреплённому треку и играющих сейчас). По умолчанию `false`.
    delete_files: Option<bool>,
}

/// Сообщает клиентам об изменении закрепления и будит менеджер.
fn pins_changed(state: &AppState, album_id: i64, track_ids: &[i64]) {
    state.events.publish_acquisition_changed(album_id);
    for &id in track_ids {
        state.events.publish(Event::LibraryChanged {
            entity: Entity::Track,
            id,
        });
    }
    state.downloads.wake();
}

#[utoipa::path(
    post,
    path = "/api/albums/{id}/download",
    tag = "downloads",
    params(("id" = i64, Path, description = "ID альбома")),
    responses(
        (status = 200, description = "Треки альбома из библиотеки закреплены: сервер скачает их и не вытеснит из кэша (идемпотентно)", body = PinResponse),
        (status = 404, description = "Нет такого альбома", body = crate::error::ErrorResponse),
    )
)]
pub async fn pin_album(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<PinResponse>, ApiError> {
    authorize(&state, &headers)?;
    albums::get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("album not found"))?;
    let mut conn = state.db.acquire().await?;
    let pinned = pins::pin_album(&mut conn, id).await?;
    pins_changed(&state, id, &[]);
    Ok(Json(PinResponse {
        pinned: u32::try_from(pinned).unwrap_or(u32::MAX),
    }))
}

#[utoipa::path(
    delete,
    path = "/api/albums/{id}/download",
    tag = "downloads",
    params(("id" = i64, Path, description = "ID альбома"), UnpinParams),
    responses(
        (status = 204, description = "Закрепление снято; недокачанное отменено, скачанное остаётся (или удалено при `delete_files=true`)"),
        (status = 404, description = "Нет такого альбома", body = crate::error::ErrorResponse),
    )
)]
pub async fn unpin_album(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(p): Query<UnpinParams>,
) -> Result<StatusCode, ApiError> {
    authorize(&state, &headers)?;
    albums::get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("album not found"))?;
    let removed = pins::unpin_album(&state.db, id).await?;
    crate::download_manager::release_files(&state, &removed, p.delete_files.unwrap_or(false))
        .await?;
    pins_changed(&state, id, &removed);
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/tracks/{id}/download",
    tag = "downloads",
    params(("id" = i64, Path, description = "ID трека")),
    responses(
        (status = 200, description = "Трек закреплён (идемпотентно)", body = PinResponse),
        (status = 404, description = "Нет такого трека", body = crate::error::ErrorResponse),
        (status = 409, description = "Трека нет в библиотеке (`not_in_library`)", body = crate::error::ErrorResponse),
    )
)]
pub async fn pin_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<PinResponse>, ApiError> {
    authorize(&state, &headers)?;
    let track = tracks::get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("track not found"))?;
    if !track.in_library {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "not_in_library",
            "track is not in the library",
        ));
    }
    let pinned = pins::pin_tracks(&state.db, &[id], false).await?;
    pins_changed(&state, track.album_id, &[id]);
    Ok(Json(PinResponse {
        pinned: u32::try_from(pinned).unwrap_or(u32::MAX),
    }))
}

#[utoipa::path(
    delete,
    path = "/api/tracks/{id}/download",
    tag = "downloads",
    params(("id" = i64, Path, description = "ID трека"), UnpinParams),
    responses(
        (status = 204, description = "Закрепление снято (идемпотентно)"),
        (status = 404, description = "Нет такого трека", body = crate::error::ErrorResponse),
    )
)]
pub async fn unpin_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(p): Query<UnpinParams>,
) -> Result<StatusCode, ApiError> {
    authorize(&state, &headers)?;
    let track = tracks::get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("track not found"))?;
    if pins::unpin_track(&state.db, id).await? {
        crate::download_manager::release_files(&state, &[id], p.delete_files.unwrap_or(false))
            .await?;
    }
    pins_changed(&state, track.album_id, &[id]);
    Ok(StatusCode::NO_CONTENT)
}

async fn set_paused(state: &AppState, paused: bool) -> Result<Json<PausedResponse>, ApiError> {
    nimbus_db::settings::set_downloads_paused(&state.db, paused).await?;
    state.downloads.wake();
    Ok(Json(PausedResponse { paused }))
}

#[utoipa::path(
    post,
    path = "/api/downloads/pause-all",
    tag = "downloads",
    responses((status = 200, description = "Новые закреплённые загрузки не стартуют, активные ради закреплений торренты на паузе (стримящиеся не трогаются); флаг переживает рестарт", body = PausedResponse))
)]
pub async fn pause_all(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<PausedResponse>, ApiError> {
    authorize(&state, &headers)?;
    set_paused(&state, true).await
}

#[utoipa::path(
    post,
    path = "/api/downloads/resume-all",
    tag = "downloads",
    responses((status = 200, description = "Закреплённые загрузки продолжаются", body = PausedResponse))
)]
pub async fn resume_all(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<PausedResponse>, ApiError> {
    authorize(&state, &headers)?;
    set_paused(&state, false).await
}
