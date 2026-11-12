//! Менеджер загрузок: список торрентов движка и ручная пауза / запуск.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use nimbus_core::model::InfoHash;
use nimbus_torrent::{EngineError, TorrentEngine, TorrentHandleId, TorrentInfo, TorrentState};
use serde::Serialize;
use utoipa::ToSchema;

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
            down_bps: t.down_bps,
            up_bps: t.up_bps,
            peers: t.peers,
            seeds: t.seeds,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DownloadsResponse {
    pub torrents: Vec<DownloadDto>,
    pub down_bps: u64,
    pub up_bps: u64,
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
    let torrents: Vec<DownloadDto> = engine(&state)?
        .list_torrents()
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(DownloadsResponse {
        down_bps: torrents.iter().map(|t| t.down_bps).sum(),
        up_bps: torrents.iter().map(|t| t.up_bps).sum(),
        torrents,
    }))
}

fn parse_id(raw: &str) -> Result<TorrentHandleId, ApiError> {
    InfoHash::parse(raw)
        .map(TorrentHandleId)
        .map_err(|e| ApiError::bad_request("invalid_info_hash", e.to_string()))
}

fn map_err(e: EngineError) -> ApiError {
    match e {
        EngineError::NotFound => ApiError::not_found("torrent not found"),
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
