mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{router, state};
use nimbus_core::Config;
use sqlx::PgPool;
use tower::ServiceExt;

const TOKEN: &str = "s3cret-token";

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn secured(pool: PgPool) -> axum::Router {
    let mut st = state(pool);
    st.config = Arc::new(
        Config::from_map(&std::collections::HashMap::from([
            ("DATABASE_URL", "postgres://unused"),
            ("NIMBUS_API_TOKEN", TOKEN),
        ]))
        .unwrap(),
    );
    router(st)
}

async fn send(app: &axum::Router, req: Request<Body>) -> axum::http::Response<Body> {
    app.clone().oneshot(req).await.unwrap()
}

fn get(uri: &str) -> axum::http::request::Builder {
    Request::get(uri)
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn open_without_token_configured(pool: PgPool) {
    let app = router(state(pool));
    let res = send(&app, get("/api/storage").body(Body::empty()).unwrap()).await;
    assert_eq!(res.status(), StatusCode::OK);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn api_requires_token_but_health_is_open(pool: PgPool) {
    let app = secured(pool);
    let res = send(&app, get("/api/health").body(Body::empty()).unwrap()).await;
    assert_eq!(res.status(), StatusCode::OK);
    for uri in ["/api/storage", "/api/settings", "/api/tracks/1/stream"] {
        let res = send(&app, get(uri).body(Body::empty()).unwrap()).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{uri}");
    }
    let res = send(
        &app,
        get("/api/storage")
            .header("authorization", "Bearer wrong")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn bearer_and_cookie_are_accepted(pool: PgPool) {
    let app = secured(pool);
    let res = send(
        &app,
        get("/api/storage")
            .header("authorization", format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let res = send(
        &app,
        get("/api/storage")
            .header("cookie", format!("x=y; nimbus_token={}", hex(TOKEN)))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn login_sets_cookie_that_works_and_logout_clears_it(pool: PgPool) {
    let app = secured(pool);
    let login = |token: &str| {
        Request::post("/api/auth/login")
            .header("content-type", "application/json")
            .header("x-forwarded-proto", "https")
            .body(Body::from(format!(r#"{{"token":"{token}"}}"#)))
            .unwrap()
    };
    let res = send(&app, login("nope")).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert!(res.headers().get("set-cookie").is_none());

    let res = send(&app, login(TOKEN)).await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let set = res.headers()["set-cookie"].to_str().unwrap().to_string();
    for part in [
        "nimbus_token=",
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        "Secure",
    ] {
        assert!(set.contains(part), "{part} in {set}");
    }
    let cookie = set.split(';').next().unwrap();
    let res = send(
        &app,
        get("/api/storage")
            .header("cookie", cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);

    let res = send(
        &app,
        Request::post("/api/auth/logout")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert!(res.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn websocket_accepts_token_in_query_only_when_valid(pool: PgPool) {
    use tokio_tungstenite::connect_async;
    let st = {
        let mut st = state(pool);
        st.config = Arc::new(
            Config::from_map(&std::collections::HashMap::from([
                ("DATABASE_URL", "postgres://unused"),
                ("NIMBUS_API_TOKEN", TOKEN),
            ]))
            .unwrap(),
        );
        st
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = nimbus_api::build_router(st);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    assert!(connect_async(format!("ws://{addr}/api/ws")).await.is_err());
    assert!(connect_async(format!("ws://{addr}/api/ws?token=bad"))
        .await
        .is_err());
    let (_ws, _) = connect_async(format!("ws://{addr}/api/ws?token={TOKEN}"))
        .await
        .expect("valid token connects");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn health_reports_jobs_and_engine(pool: PgPool) {
    let (status, v) = common::get_json(router(state(pool)), "/api/health").await;
    assert_eq!(status, 200);
    assert_eq!(v["jobs"]["queued"], 0);
    assert_eq!(v["jobs"]["running"], 0);
    assert_eq!(v["jobs"]["failed_24h"], 0);
    assert!(v["engine"].is_null());
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn every_api_route_is_closed_without_a_token(pool: PgPool) {
    let app = secured(pool);
    let get_paths = [
        "/api/search?q=radiohead",
        "/api/library/artists",
        "/api/library/albums",
        "/api/library/tracks",
        "/api/artists/1",
        "/api/albums/1",
        "/api/tracks/1",
        "/api/albums/1/torrents",
        "/api/tracks/1/sources",
        "/api/torrents/1/files",
        "/api/storage",
        "/api/settings",
        "/api/debug/jobs",
    ];
    for uri in get_paths {
        let res = send(&app, get(uri).body(Body::empty()).unwrap()).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "GET {uri}");
    }
    for (method, uri) in [
        ("POST", "/api/library"),
        ("DELETE", "/api/library/album/1"),
        ("POST", "/api/artists/1/import"),
        ("POST", "/api/albums/1/retry"),
        ("POST", "/api/tracks/1/retry"),
        ("PUT", "/api/settings"),
        ("POST", "/api/settings/providers/test"),
    ] {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let res = send(&app, req).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
    // Публичные: схема и проверка живости.
    for uri in ["/api/health", "/api/openapi.json"] {
        let res = send(&app, get(uri).body(Body::empty()).unwrap()).await;
        assert_eq!(res.status(), StatusCode::OK, "{uri}");
    }
    // С токеном — открыто.
    let res = send(
        &app,
        get("/api/library/artists")
            .header("authorization", format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}
