use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use nimbus_api::{build_router, AppState};
use nimbus_core::events::EventBus;
use nimbus_core::Config;
use sqlx::PgPool;
use tower::ServiceExt;

fn test_config() -> Config {
    Config::from_map(&std::collections::HashMap::from([(
        "DATABASE_URL",
        "postgres://unused",
    )]))
    .unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn health_ok(pool: PgPool) {
    let app = build_router(AppState {
        db: pool,
        config: Arc::new(test_config()),
        events: EventBus::new(),
    });
    let res = app
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["status"], "ok");
    assert_eq!(v["db"], true);
    assert_eq!(v["version"], "0.1.0");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn cors_header_for_configured_origin(pool: PgPool) {
    let app = build_router(AppState {
        db: pool,
        config: Arc::new(test_config()),
        events: EventBus::new(),
    });
    let res = app
        .oneshot(
            Request::get("/api/health")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.headers().get("access-control-allow-origin").unwrap(),
        "http://localhost:3000"
    );
}
