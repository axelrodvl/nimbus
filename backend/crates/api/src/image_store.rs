//! Дисковый кэш изображений (обложки Cover Art Archive, фото артистов).
//!
//! Картинка скачивается с внешнего источника один раз, кладётся в `{data_dir}/images/` и дальше отдаётся с того же
//! origin с `Cache-Control: public, max-age=31536000, immutable` — браузер и service worker хранят её без перепроверок
//! и без запросов к `archive.org` (у него нет заголовков кэширования, а редиректы не кэшируются).
//! «Нет картинки» запоминается маркером `.none` на сутки, чтобы не дёргать источник при каждом показе списка.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;

use crate::error::ApiError;

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const MISS_TTL: Duration = Duration::from_secs(24 * 3600);
/// Больше этого не принимаем: это обложка/фото, а не произвольный файл.
const MAX_BYTES: usize = 10 * 1024 * 1024;

pub const IMMUTABLE: &str = "public, max-age=31536000, immutable";

fn images_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("images")
}

/// Тип содержимого по сигнатуре; `None` — не картинка.
fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if b.starts_with(b"GIF8") {
        Some("image/gif")
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn image_response(bytes: Vec<u8>, ct: &'static str) -> Response {
    let mut r = Response::new(Body::from(bytes));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(ct));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(IMMUTABLE));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    r
}

fn no_image() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no_image", "no image")
}

async fn fresh_marker(path: &Path) -> bool {
    match tokio::fs::metadata(path).await.and_then(|m| m.modified()) {
        Ok(t) => SystemTime::now()
            .duration_since(t)
            .is_ok_and(|age| age < MISS_TTL),
        Err(_) => false,
    }
}

async fn download(url: &str, user_agent: &str) -> Result<Option<Vec<u8>>, ApiError> {
    let http = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(user_agent.to_string())
        .build()
        .map_err(|_| ApiError::internal())?;
    let res =
        http.get(url).send().await.map_err(|e| {
            ApiError::new(StatusCode::BAD_GATEWAY, "image_unavailable", e.to_string())
        })?;
    if res.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "image_unavailable",
            format!("upstream status {}", res.status()),
        ));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, "image_unavailable", e.to_string()))?;
    if bytes.len() > MAX_BYTES {
        return Ok(None);
    }
    Ok(Some(bytes.to_vec()))
}

/// Отдаёт картинку `name` из дискового кэша; нет — скачивает `url()` и сохраняет.
/// `name` — только `[a-z0-9-]` (собирается из типизированных частей, не из ввода пользователя).
/// Временная ошибка источника не запоминается (`502`, повтор при следующем запросе).
pub async fn serve<F, Fut>(
    data_dir: &Path,
    user_agent: &str,
    name: &str,
    url: F,
) -> Result<Response, ApiError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Option<String>, ApiError>>,
{
    let dir = images_dir(data_dir);
    let file = dir.join(format!("{name}.img"));
    let marker = dir.join(format!("{name}.none"));
    if let Ok(bytes) = tokio::fs::read(&file).await {
        if let Some(ct) = sniff(&bytes) {
            return Ok(image_response(bytes, ct));
        }
    }
    if fresh_marker(&marker).await {
        return Err(no_image());
    }
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| ApiError::internal())?;
    let found = match url().await? {
        Some(u) => download(&u, user_agent).await?,
        None => None,
    };
    let Some(bytes) = found else {
        let _ = tokio::fs::write(&marker, b"").await;
        return Err(no_image());
    };
    let Some(ct) = sniff(&bytes) else {
        let _ = tokio::fs::write(&marker, b"").await;
        return Err(no_image());
    };
    // Через временный файл: параллельный запрос не увидит недописанную картинку.
    let tmp = dir.join(format!("{name}.{}.tmp", std::process::id()));
    if tokio::fs::write(&tmp, &bytes).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, &file).await;
    }
    Ok(image_response(bytes, ct))
}
