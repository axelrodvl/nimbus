//! Раздача собранного SPA (`client/dist`) самим бэкендом: один origin, один контейнер.
//!
//! Включается переменной `NIMBUS_WEB_DIR`; без неё бэкенд отдаёт только `/api` (разработка и тесты).
//! Правила: файл из каталога — как есть (предсжатые `.br`/`.gz` рядом), отсутствующий файл при
//! навигации (`GET`, `Accept: text/html`, путь без расширения) — `index.html` (маршруты SPA),
//! иначе честный 404. Подмена отсутствующего `.js` на HTML недопустима: service worker закэшировал бы
//! его как скрипт и приложение сломалось бы до ручной очистки.

use std::convert::Infallible;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use tower::ServiceExt;
use tower_http::services::ServeDir;

/// Политика безопасности контента. `connect-src` включает хосты обложек: их запрашивает сам service worker.
/// CSP проверяет и редиректы: обложка идёт coverartarchive.org → archive.org (голый домен не входит в `*.archive.org`)
/// → iaNNN.us.archive.org, фото артиста — на Commons (upload.wikimedia.org) или CDN Deezer.
const CSP: &str = "default-src 'self'; \
img-src 'self' https://coverartarchive.org https://archive.org https://*.archive.org https://upload.wikimedia.org https://commons.wikimedia.org https://*.dzcdn.net data: blob:; \
media-src 'self' blob:; \
connect-src 'self' https://coverartarchive.org https://archive.org https://*.archive.org; \
style-src 'self' 'unsafe-inline'; \
script-src 'self'; \
worker-src 'self'; \
object-src 'none'; \
base-uri 'self'; \
frame-ancestors 'none'";

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";

/// Обработчик статики для `Router::fallback_service`.
#[derive(Clone)]
struct WebDir {
    dir: ServeDir,
}

/// Подключает fallback роутера. Без каталога (или без `index.html` в нём — предупреждение в лог при старте)
/// все неизвестные пути отвечают 404: под `/api` — JSON-ошибкой, остальные — пустым телом.
pub fn mount<S>(router: Router<S>, root: Option<&Path>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let Some(root) = root.filter(|root| {
        let ok = root.join("index.html").is_file();
        if !ok {
            tracing::warn!(dir = %root.display(), "NIMBUS_WEB_DIR has no index.html: SPA is not served");
        }
        ok
    }) else {
        return router.fallback(|req: Request| async move { not_found(req.uri().path()) });
    };
    let web = WebDir {
        dir: ServeDir::new(PathBuf::from(root))
            .precompressed_br()
            .precompressed_gzip()
            .append_index_html_on_directories(true),
    };
    router.fallback(move |req: Request| {
        let web = web.clone();
        async move { web.serve(req).await }
    })
}

impl WebDir {
    async fn serve(self, req: Request) -> Response {
        let (parts, _) = req.into_parts();
        let path = parts.uri.path().to_owned();
        // Неизвестный путь под /api — JSON-ошибка, а не HTML.
        if is_api(&path) {
            return not_found(&path);
        }
        if !matches!(parts.method, Method::GET | Method::HEAD) {
            return StatusCode::METHOD_NOT_ALLOWED.into_response();
        }
        let mut res = self.call(&parts, &parts.uri).await;
        let mut served = path.clone();
        if res.status() == StatusCode::NOT_FOUND && is_navigation(&parts.headers, &path) {
            let index = Uri::from_static("/index.html");
            res = self.call(&parts, &index).await;
            served = "/index.html".into();
        }
        decorate(&mut res, &served);
        res
    }

    async fn call(&self, parts: &axum::http::request::Parts, uri: &Uri) -> Response {
        let mut b = Request::builder()
            .method(parts.method.clone())
            .uri(uri.clone());
        // Условные и сжатые запросы: только то, что понимает ServeDir.
        for name in [
            header::ACCEPT_ENCODING,
            header::IF_MODIFIED_SINCE,
            header::IF_UNMODIFIED_SINCE,
            header::RANGE,
        ] {
            if let Some(v) = parts.headers.get(&name) {
                b = b.header(name, v);
            }
        }
        let req = b.body(Body::empty()).unwrap_or_default();
        let res: Result<_, Infallible> = self.dir.clone().oneshot(req).await;
        match res {
            Ok(r) => r.map(Body::new),
            Err(never) => match never {},
        }
    }
}

/// Навигация браузера по маршруту SPA: `GET`/`HEAD` с `Accept: text/html` и путём без расширения.
fn is_navigation(headers: &HeaderMap, path: &str) -> bool {
    let wants_html = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/html"));
    let last = path.rsplit('/').next().unwrap_or("");
    wants_html && !last.contains('.')
}

/// Кэширование и заголовки безопасности. `served` — путь реально отданного файла.
fn decorate(res: &mut Response, served: &str) {
    let ok = res.status().is_success();
    let h = res.headers_mut();
    if ok {
        // Файлы в /assets/ несут хэш в имени; всё остальное (index.html, sw.js, манифест) проверяется всегда.
        let cache = if served.starts_with("/assets/") {
            IMMUTABLE
        } else {
            NO_CACHE
        };
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    }
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
}

fn is_api(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

fn not_found(path: &str) -> Response {
    if is_api(path) {
        crate::error::ApiError::not_found("no such endpoint").into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}
