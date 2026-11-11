use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use nimbus_db::repo::jobs;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::{IntoParams, ToSchema};

use crate::auth::authorize;
use crate::error::ApiError;
use crate::openapi::openapi;
use crate::search::search;
use crate::state::AppState;
use crate::ws::ws_handler;

pub fn api_routes(state: &AppState) -> Router<AppState> {
    let mut r = Router::new()
        .route("/health", get(health))
        .route("/openapi.json", get(openapi_json))
        .route("/search", get(search))
        .route("/ws", get(ws_handler));
    if cfg!(debug_assertions) || state.config.debug {
        r = r.route("/debug/jobs", get(debug_jobs));
    }
    r
}

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
    pub db: bool,
    pub version: String,
}

#[utoipa::path(
    get,
    path = "/api/health",
    tag = "system",
    responses((status = 200, description = "Сервис работает, БД доступна", body = HealthResponse))
)]
pub async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, ApiError> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(HealthResponse {
        status: "ok".into(),
        db: true,
        version: env!("CARGO_PKG_VERSION").into(),
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
