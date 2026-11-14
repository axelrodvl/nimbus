// Интеграционные тесты: unwrap в вспомогательных функциях допустим.
#![allow(clippy::unwrap_used)]
mod common;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::Router;
use common::{router, state};
use http_body_util::BodyExt;
use nimbus_core::Config;
use sqlx::PgPool;
use tower::ServiceExt;

const INDEX: &str = r#"<!doctype html><div id="root"></div>"#;
const TOKEN: &str = "s3cret-token";

/// Каталог SPA + секретный файл рядом (вне каталога) для проверки обхода.
struct Site {
    _tmp: tempfile::TempDir,
    root: std::path::PathBuf,
}

fn site() -> Site {
    let tmp = nimbus_testkit::tempdir();
    let root = tmp.path().join("web");
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(root.join("index.html"), INDEX).unwrap();
    std::fs::write(root.join("sw.js"), "self.skipWaiting()").unwrap();
    std::fs::write(root.join("manifest.webmanifest"), "{}").unwrap();
    std::fs::write(root.join("assets/app-abc123.js"), "console.log(1)").unwrap();
    std::fs::write(root.join("assets/app-abc123.js.br"), "br-bytes").unwrap();
    std::fs::write(root.join("assets/app-abc123.js.gz"), "gz-bytes").unwrap();
    std::fs::write(tmp.path().join("secret"), "TOP-SECRET").unwrap();
    Site { _tmp: tmp, root }
}

fn app(pool: PgPool, web_dir: Option<&Path>, token: Option<&str>) -> Router {
    let mut env = HashMap::from([("DATABASE_URL", "postgres://unused")]);
    if let Some(t) = token {
        env.insert("NIMBUS_API_TOKEN", t);
    }
    let dir = web_dir.map(|p| p.to_str().unwrap().to_owned());
    if let Some(d) = &dir {
        env.insert("NIMBUS_WEB_DIR", d);
    }
    let mut st = state(pool);
    st.config = Arc::new(Config::from_map(&env).unwrap());
    router(st)
}

async fn fetch(app: &Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let res = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes().to_vec();
    (parts.status, parts.headers, bytes)
}

fn nav(uri: &str) -> Request<Body> {
    Request::get(uri)
        .header(header::ACCEPT, "text/html,application/xhtml+xml")
        .body(Body::empty())
        .unwrap()
}

fn plain(uri: &str) -> Request<Body> {
    Request::get(uri)
        .header(header::ACCEPT, "*/*")
        .body(Body::empty())
        .unwrap()
}

fn h<'a>(headers: &'a axum::http::HeaderMap, name: &str) -> &'a str {
    headers.get(name).unwrap().to_str().unwrap()
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn navigation_returns_index_html_with_no_cache(pool: PgPool) {
    let s = site();
    let a = app(pool, Some(&s.root), None);
    for uri in ["/", "/album/5", "/library/playlists"] {
        let (status, headers, body) = fetch(&a, nav(uri)).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(body, INDEX.as_bytes(), "{uri}");
        assert_eq!(h(&headers, "cache-control"), "no-cache", "{uri}");
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn hashed_asset_is_immutable(pool: PgPool) {
    let s = site();
    let a = app(pool, Some(&s.root), None);
    let (status, headers, body) = fetch(&a, plain("/assets/app-abc123.js")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"console.log(1)");
    assert_eq!(
        h(&headers, "cache-control"),
        "public, max-age=31536000, immutable"
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn precompressed_variants_are_served_by_accept_encoding(pool: PgPool) {
    let s = site();
    let a = app(pool, Some(&s.root), None);
    let req = |enc: &str| {
        Request::get("/assets/app-abc123.js")
            .header(header::ACCEPT_ENCODING, enc)
            .body(Body::empty())
            .unwrap()
    };
    let (_, headers, body) = fetch(&a, req("br, gzip")).await;
    assert_eq!(h(&headers, "content-encoding"), "br");
    assert_eq!(body, b"br-bytes");
    let (_, headers, body) = fetch(&a, req("gzip")).await;
    assert_eq!(h(&headers, "content-encoding"), "gzip");
    assert_eq!(body, b"gz-bytes");
    let (_, headers, body) = fetch(&a, req("identity")).await;
    assert!(headers.get("content-encoding").is_none());
    assert_eq!(body, b"console.log(1)");
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn missing_asset_is_404_not_index_html(pool: PgPool) {
    let s = site();
    let a = app(pool, Some(&s.root), None);
    for req in [plain("/assets/missing.js"), nav("/assets/missing.js")] {
        let (status, _, body) = fetch(&a, req).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(!String::from_utf8_lossy(&body).contains("root"));
    }
    // Не навигация (fetch/XHR) по маршруту SPA — тоже 404.
    let (status, _, _) = fetch(&a, plain("/album/5")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn unknown_api_path_is_json_404(pool: PgPool) {
    let s = site();
    for dir in [Some(s.root.as_path()), None] {
        let a = app(pool.clone(), dir, None);
        let (status, headers, body) = fetch(&a, nav("/api/nope")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(h(&headers, "content-type").starts_with("application/json"));
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"]["code"], "not_found");
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn service_worker_and_manifest_are_no_cache(pool: PgPool) {
    let s = site();
    let a = app(pool, Some(&s.root), None);
    for uri in ["/sw.js", "/manifest.webmanifest"] {
        let (status, headers, _) = fetch(&a, plain(uri)).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(h(&headers, "cache-control"), "no-cache", "{uri}");
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn path_traversal_never_leaves_the_directory(pool: PgPool) {
    let s = site();
    let a = app(pool, Some(&s.root), None);
    for uri in [
        "/../secret",
        "/%2e%2e/secret",
        "/%2E%2E/secret",
        "/assets/..%2f..%2fsecret",
        "/assets/../../secret",
        "/assets/%2e%2e/%2e%2e/secret",
        "/..%5csecret",
    ] {
        for req in [plain(uri), nav(uri)] {
            let (status, _, body) = fetch(&a, req).await;
            assert!(
                !String::from_utf8_lossy(&body).contains("TOP-SECRET"),
                "{uri} leaked"
            );
            assert!(
                status == StatusCode::NOT_FOUND
                    || status == StatusCode::BAD_REQUEST
                    // навигация без расширения может законно вернуть index.html
                    || (status == StatusCode::OK && body == INDEX.as_bytes()),
                "{uri}: {status}"
            );
        }
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn static_files_need_no_token_but_api_does(pool: PgPool) {
    let s = site();
    let a = app(pool, Some(&s.root), Some(TOKEN));
    assert_eq!(fetch(&a, nav("/")).await.0, StatusCode::OK);
    assert_eq!(fetch(&a, nav("/album/1")).await.0, StatusCode::OK);
    assert_eq!(
        fetch(&a, plain("/assets/app-abc123.js")).await.0,
        StatusCode::OK
    );
    assert_eq!(
        fetch(&a, plain("/api/library/albums")).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn without_web_dir_root_is_404_and_api_works(pool: PgPool) {
    let a = app(pool, None, None);
    assert_eq!(fetch(&a, nav("/")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(fetch(&a, plain("/api/health")).await.0, StatusCode::OK);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn missing_web_dir_starts_and_root_is_404(pool: PgPool) {
    let s = site();
    let missing = s.root.join("does-not-exist");
    let a = app(pool, Some(&missing), None);
    assert_eq!(fetch(&a, nav("/")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(fetch(&a, plain("/api/health")).await.0, StatusCode::OK);
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn html_response_carries_security_headers(pool: PgPool) {
    let s = site();
    let a = app(pool, Some(&s.root), None);
    let (_, headers, _) = fetch(&a, nav("/")).await;
    assert_eq!(h(&headers, "x-content-type-options"), "nosniff");
    assert_eq!(h(&headers, "referrer-policy"), "same-origin");
    let csp = h(&headers, "content-security-policy");
    for part in [
        "default-src 'self'",
        "script-src 'self'",
        "media-src 'self' blob:",
        "worker-src 'self'",
        "https://coverartarchive.org",
        "https://*.archive.org",
    ] {
        assert!(csp.contains(part), "CSP lacks {part}: {csp}");
    }
}

#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]
async fn non_get_method_on_static_path_is_405(pool: PgPool) {
    let s = site();
    let a = app(pool, Some(&s.root), None);
    let req = Request::post("/").body(Body::empty()).unwrap();
    assert_eq!(fetch(&a, req).await.0, StatusCode::METHOD_NOT_ALLOWED);
}
