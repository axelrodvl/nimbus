// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{get_json, router, state};
use sqlx::PgPool;
use tower::ServiceExt;

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn health_ok(pool: PgPool) {
    let (status, v) = get_json(router(state(pool)), "/api/health").await;
    assert_eq!(status, 200);
    assert_eq!(v["status"], "ok");
    assert_eq!(v["db"], true);
    assert_eq!(v["version"], "0.1.0");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn cors_header_for_configured_origin(pool: PgPool) {
    let res = router(state(pool))
        .oneshot(
            Request::get("/api/health")
                .header("origin", "http://localhost:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers().get("access-control-allow-origin").unwrap(),
        "http://localhost:3000"
    );
}
