use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::state::AppState;

pub fn api_routes() -> Router<AppState> {
    Router::new().route("/health", get(health))
}

async fn health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(json!({
        "status": "ok",
        "db": true,
        "version": env!("CARGO_PKG_VERSION"),
    })))
}
