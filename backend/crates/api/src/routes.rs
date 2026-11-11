use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use nimbus_db::repo::jobs;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::{IntoParams, ToSchema};

use crate::auth::authorize;
use crate::error::ApiError;
use crate::library;
use crate::openapi::openapi;
use crate::search::search;
use crate::sources;
use crate::state::AppState;
use crate::ws::ws_handler;

pub fn api_routes(state: &AppState) -> Router<AppState> {
    let mut r = Router::new()
        .route("/health", get(health))
        .route("/openapi.json", get(openapi_json))
        .route("/search", get(search))
        .route("/library", post(library::add_to_library))
        .route("/library/{type}/{id}", delete(library::remove_from_library))
        .route("/library/artists", get(library::list_artists))
        .route("/library/albums", get(library::list_albums))
        .route("/library/tracks", get(library::list_tracks))
        .route("/artists/{id}", get(library::get_artist))
        .route("/artists/{id}/import", post(library::retry_artist_import))
        .route("/albums/{id}", get(library::get_album))
        .route("/tracks/{id}", get(library::get_track))
        .route("/tracks/{id}/stream", get(crate::stream::stream_track))
        .route(
            "/internal/raw/{torrent_id}/{file_index}",
            get(crate::stream::raw_file),
        )
        .route(
            "/albums/{id}/torrents",
            get(sources::album_torrents_list).post(sources::add_magnet),
        )
        .route("/albums/{id}/retry", post(sources::retry_album))
        .route("/torrents/{id}/files", get(sources::torrent_files))
        .route("/tracks/{id}/sources", get(sources::track_sources_list))
        .route("/tracks/{id}/source", put(sources::set_source))
        .route(
            "/tracks/{id}/sources/{source_id}/confirm",
            post(sources::confirm_source),
        )
        .route("/tracks/{id}/retry", post(sources::retry_track))
        .route(
            "/settings",
            get(crate::settings::get_settings).put(crate::settings::put_settings),
        )
        .route(
            "/settings/providers/test",
            post(crate::settings::test_provider),
        )
        .route("/storage", get(crate::settings::get_storage))
        .route("/tracks/{id}/prefetch", post(crate::stream::prefetch_track))
        .route("/auth/login", post(crate::auth::login))
        .route("/auth/logout", post(crate::auth::logout))
        .route("/ws", get(ws_handler));
    if cfg!(debug_assertions) || state.config.debug {
        r = r
            .route("/debug/jobs", get(debug_jobs))
            .route("/debug/torrent/metadata", post(debug_torrent_metadata))
            .route("/debug/albums/{id}/torrents", get(debug_album_torrents));
    }
    r
}

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
    pub db: bool,
    pub version: String,
    /// Торрент-движок (`null`, если не запущен).
    pub engine: Option<EngineHealth>,
    pub jobs: JobsHealth,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EngineHealth {
    pub torrents: u64,
    pub down_bps: u64,
    pub up_bps: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct JobsHealth {
    pub queued: i64,
    pub running: i64,
    /// Задачи в состоянии `failed`, обновлённые за последние 24 часа.
    pub failed_24h: i64,
}

#[utoipa::path(
    get,
    path = "/api/health",
    tag = "system",
    responses((status = 200, description = "Сервис работает, БД доступна", body = HealthResponse))
)]
pub async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, ApiError> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    let (queued, running, failed_24h): (i64, i64, i64) = sqlx::query_as(
        "SELECT
            COUNT(*) FILTER (WHERE state = 'queued'),
            COUNT(*) FILTER (WHERE state = 'running'),
            COUNT(*) FILTER (WHERE state = 'failed' AND updated_at > now() - interval '24 hours')
         FROM jobs",
    )
    .fetch_one(&state.db)
    .await?;
    Ok(Json(HealthResponse {
        status: "ok".into(),
        db: true,
        version: env!("CARGO_PKG_VERSION").into(),
        engine: state.engine.as_ref().map(|e| {
            let s = e.stats();
            EngineHealth {
                torrents: s.torrents,
                down_bps: s.down_bps,
                up_bps: s.up_bps,
            }
        }),
        jobs: JobsHealth {
            queued,
            running,
            failed_24h,
        },
    }))
}

async fn openapi_json() -> Json<utoipa::openapi::OpenApi> {
    Json(openapi())
}

/// Только документация: сам обработчик — `ws::ws_handler`.
#[utoipa::path(
    get,
    path = "/api/ws",
    tag = "system",
    responses((status = 101, description = "WebSocket: события `track.status`, `job.progress`, `stream.progress`, `library.changed`, `resync`"))
)]
pub fn ws_doc() {}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DebugJobsQuery {
    state: Option<String>,
    limit: Option<i64>,
}

#[utoipa::path(
    get,
    path = "/api/debug/jobs",
    tag = "system",
    params(DebugJobsQuery),
    responses((status = 200, description = "Список задач (только debug / NIMBUS_DEBUG=true)", body = Object))
)]
pub async fn debug_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DebugJobsQuery>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers)?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let rows = jobs::list(
        &state.db,
        q.state.as_deref().filter(|s| !s.is_empty()),
        limit,
    )
    .await?;
    Ok(Json(json!({ "jobs": rows })))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DebugMetadataRequest {
    pub magnet: String,
}

#[utoipa::path(
    post,
    path = "/api/debug/torrent/metadata",
    tag = "system",
    request_body = DebugMetadataRequest,
    responses(
        (status = 200, description = "Список файлов торрента без скачивания (только debug / NIMBUS_DEBUG=true)", body = Object),
        (status = 400, description = "Некорректный magnet", body = crate::error::ErrorResponse),
        (status = 504, description = "Метаданные не получены вовремя", body = crate::error::ErrorResponse),
    )
)]
pub async fn debug_torrent_metadata(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<DebugMetadataRequest>,
) -> Result<Json<Value>, ApiError> {
    use axum::http::StatusCode;
    use nimbus_torrent::EngineError;

    authorize(&state, &headers)?;
    let engine = state.engine.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "engine_unavailable",
            "torrent engine is not running",
        )
    })?;
    let meta = engine
        .fetch_metadata(&req.magnet)
        .await
        .map_err(|e| match e {
            EngineError::InvalidMagnet(m) => ApiError::bad_request("invalid_magnet", m),
            EngineError::MetadataTimeout => ApiError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "metadata_timeout",
                "torrent metadata was not received in time",
            ),
            other => ApiError::new(StatusCode::BAD_GATEWAY, "torrent_error", other.to_string()),
        })?;
    Ok(Json(json!({
        "info_hash": meta.info_hash,
        "name": meta.name,
        "piece_length": meta.piece_length,
        "files": meta.files.iter().map(|f| json!({
            "index": f.index, "path": f.path, "size": f.size,
        })).collect::<Vec<_>>(),
    })))
}

#[utoipa::path(
    get,
    path = "/api/debug/albums/{id}/torrents",
    tag = "system",
    params(("id" = i64, Path, description = "ID альбома")),
    responses((status = 200, description = "Раздачи альбома: статус метаданных, число файлов и найденных треков (только debug / NIMBUS_DEBUG=true)", body = Object))
)]
pub async fn debug_album_torrents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers)?;
    let rows = nimbus_db::repo::album_torrents::overview(&state.db, id).await?;
    Ok(Json(json!({ "album_id": id, "torrents": rows })))
}
