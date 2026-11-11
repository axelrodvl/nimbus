use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use nimbus_db::repo::jobs;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::authorize;
use crate::error::ApiError;
use crate::state::AppState;
use crate::ws::ws_handler;

pub fn api_routes(state: &AppState) -> Router<AppState> {
    let mut r = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_handler));
    if cfg!(debug_assertions) || state.config.debug {
        r = r.route("/debug/jobs", get(debug_jobs));
    }
    r
}

async fn health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(json!({
        "status": "ok",
        "db": true,
        "version": env!("CARGO_PKG_VERSION"),
    })))
}

#[derive(Deserialize)]
struct DebugJobsQuery {
    state: Option<String>,
    limit: Option<i64>,
}

async fn debug_jobs(
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
