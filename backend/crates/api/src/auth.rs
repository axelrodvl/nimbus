//! Однопользовательская авторизация по статическому токену (`NIMBUS_API_TOKEN`).
//!
//! Токен принимается из заголовка `Authorization: Bearer`, из cookie `nimbus_token`
//! (нужна для `<audio src>` и WebSocket) и — только для WS — из `?token=`.
//! В cookie значение хранится hex-кодированным, чтобы любой токен был допустим.

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use subtle::ConstantTimeEq;
use utoipa::ToSchema;

use crate::error::ApiError;
use crate::state::AppState;

pub const COOKIE_NAME: &str = "nimbus_token";
const COOKIE_MAX_AGE: u64 = 60 * 60 * 24 * 30;

fn unauthorized() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "missing or invalid API token",
    )
}

fn eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

fn hex_encode(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Option<String> {
    if !s.len().is_multiple_of(2) || !s.is_ascii() {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

fn cookie_value(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE_NAME)
        .and_then(|(_, v)| hex_decode(v))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = v.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

/// Проверка токена по всем источникам; сравнение за постоянное время.
fn token_ok(expected: &str, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    let mut ok = false;
    if let Some(t) = bearer(headers) {
        ok |= eq(t, expected);
    }
    if let Some(t) = cookie_value(headers) {
        ok |= eq(&t, expected);
    }
    if let Some(t) = query_token {
        ok |= eq(t, expected);
    }
    ok
}

/// Гард доступа: если токен не задан — пропускает всех.
pub fn authorize(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    authorize_with_query(state, headers, None)
}

/// То же, но допускает токен в query (WebSocket).
pub fn authorize_with_query(
    state: &AppState,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Result<(), ApiError> {
    match state.config.api_token.as_deref() {
        None => Ok(()),
        Some(expected) if token_ok(expected, headers, query_token) => Ok(()),
        Some(_) => Err(unauthorized()),
    }
}

/// Пути, доступные без токена: проверка живости, вход/выход, схема OpenAPI.
/// `/api/internal/raw/…` защищён проверкой loopback в самом обработчике (его вызывает ffmpeg),
/// `/api/ws` проверяет токен сам (допускает ещё и `?token=`).
fn is_public(path: &str) -> bool {
    matches!(
        path,
        "/api/health" | "/api/openapi.json" | "/api/auth/login" | "/api/auth/logout" | "/api/ws"
    ) || path.starts_with("/api/internal/raw/")
}

/// Слой авторизации для всего API: новые маршруты закрыты по умолчанию, а не «если не забыли `authorize`».
pub async fn require_token(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<Response, ApiError> {
    let path = req.uri().path();
    if state.config.api_token.is_none()
        || req.method() == axum::http::Method::OPTIONS
        || is_public(path)
    {
        return Ok(next.run(req).await);
    }
    authorize_with_query(&state, req.headers(), None)?;
    Ok(next.run(req).await)
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct LoginRequest {
    pub token: String,
}

fn set_cookie(value: &str, max_age: u64, headers: &HeaderMap) -> HeaderValue {
    let secure = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("https"));
    let mut c = format!("{COOKIE_NAME}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}");
    if secure {
        c.push_str("; Secure");
    }
    HeaderValue::from_str(&c).expect("cookie is ascii")
}

#[utoipa::path(
    post,
    path = "/api/auth/login",
    tag = "system",
    request_body = LoginRequest,
    responses(
        (status = 204, description = "Токен верный; cookie `nimbus_token` установлена (или авторизация выключена)"),
        (status = 401, description = "Неверный токен", body = crate::error::ErrorResponse),
    )
)]
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> Result<Response, ApiError> {
    let Some(expected) = state.config.api_token.as_deref() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if !eq(req.token.trim(), expected) {
        return Err(unauthorized());
    }
    let cookie = set_cookie(&hex_encode(expected), COOKIE_MAX_AGE, &headers);
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response())
}

#[utoipa::path(
    post,
    path = "/api/auth/logout",
    tag = "system",
    responses((status = 204, description = "Cookie `nimbus_token` удалена"))
)]
pub async fn logout(headers: HeaderMap) -> Response {
    let cookie = set_cookie("", 0, &headers);
    (StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        for s in ["abc", "тест", "a;b=c d"] {
            assert_eq!(hex_decode(&hex_encode(s)).as_deref(), Some(s));
        }
        assert!(hex_decode("zz").is_none() && hex_decode("abc").is_none());
    }

    #[test]
    fn sources() {
        let mut h = HeaderMap::new();
        assert!(!token_ok("s3", &h, None));
        h.insert(header::AUTHORIZATION, "Bearer s3".parse().unwrap());
        assert!(token_ok("s3", &h, None));
        assert!(!token_ok("other", &h, None));
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            format!("a=b; {COOKIE_NAME}={}", hex_encode("s3"))
                .parse()
                .unwrap(),
        );
        assert!(token_ok("s3", &h, None));
        assert!(token_ok("s3", &HeaderMap::new(), Some("s3")));
        assert!(!token_ok("s3", &HeaderMap::new(), Some("x")));
    }
}
