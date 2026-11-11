#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use axum::Router;
use http_body_util::BodyExt;
use nimbus_api::{build_router, AppState};
use nimbus_core::events::EventBus;
use nimbus_core::Config;
use nimbus_musicbrainz::{MbClient, MbConfig};
use sqlx::PgPool;
use tower::ServiceExt;
use wiremock::MockServer;

pub fn test_config() -> Config {
    Config::from_map(&std::collections::HashMap::from([(
        "DATABASE_URL",
        "postgres://unused",
    )]))
    .unwrap()
}

/// Клиент MB, направленный на wiremock, с быстрым лимитером.
pub fn mb_client(server: &MockServer) -> MbClient {
    let mut c = MbConfig::new("NimbusTest/0.1 ( https://example.org/test )");
    c.base = format!("{}/ws/2/", server.uri()).parse().unwrap();
    c.min_interval = Duration::from_millis(1);
    c.retry_delay = Duration::from_millis(5);
    MbClient::with_config(c, None).unwrap()
}

/// Состояние с MB, которого нет (любой запрос к нему упадёт) — для тестов без поиска.
pub fn state(pool: PgPool) -> AppState {
    let mut c = MbConfig::new("NimbusTest/0.1 ( https://example.org/test )");
    c.base = "http://127.0.0.1:9/ws/2/".parse().unwrap();
    AppState::new(
        pool,
        Arc::new(test_config()),
        EventBus::new(),
        MbClient::with_config(c, None).unwrap(),
    )
}

pub fn state_with_mb(pool: PgPool, mb: MbClient) -> AppState {
    AppState::new(pool, Arc::new(test_config()), EventBus::new(), mb)
}

pub async fn get_json(app: Router, uri: &str) -> (u16, serde_json::Value) {
    let res = app
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

pub fn router(state: AppState) -> Router {
    build_router(state)
}

pub async fn request_json(
    app: Router,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let mut req = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let res = app.oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

pub async fn post_json(
    app: Router,
    uri: &str,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    request_json(app, "POST", uri, Some(body)).await
}

pub async fn delete(app: Router, uri: &str) -> (u16, serde_json::Value) {
    request_json(app, "DELETE", uri, None).await
}
