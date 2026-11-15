//! `GET /api/covers/{kind}/{mbid}/{size}`: обложка Cover Art Archive через дисковый кэш бэкенда.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use uuid::Uuid;

use crate::auth::authorize;
use crate::error::ApiError;
use crate::state::AppState;

#[utoipa::path(
    get,
    path = "/api/covers/{kind}/{mbid}/{size}",
    tag = "library",
    params(
        ("kind" = String, Path, description = "`release-group` или `release`"),
        ("mbid" = Uuid, Path, description = "MBID"),
        ("size" = u16, Path, description = "Размер миниатюры: 250 или 500"),
    ),
    responses(
        (status = 200, description = "Картинка (`image/*`); `Cache-Control: public, max-age=31536000, immutable`"),
        (status = 404, description = "Обложки нет (`no_image`) или неизвестный вид/размер", body = crate::error::ErrorResponse),
        (status = 502, description = "Cover Art Archive недоступен (`image_unavailable`); не запоминается", body = crate::error::ErrorResponse),
    )
)]
pub async fn cover(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((kind, mbid, size)): Path<(String, Uuid, u16)>,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    if !matches!(kind.as_str(), "release-group" | "release") || !matches!(size, 250 | 500) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "no_image",
            "unknown cover kind or size",
        ));
    }
    let name = format!("cover-{kind}-{mbid}-{size}");
    let url = format!("https://coverartarchive.org/{kind}/{mbid}/front-{size}");
    crate::image_store::serve(
        &state.config.data_dir,
        &state.config.mb_user_agent,
        &name,
        || async move { Ok(Some(url)) },
    )
    .await
}
