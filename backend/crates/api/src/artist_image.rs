//! `GET /api/artist-image/{mbid}`: фото артиста (скачивается один раз и отдаётся из дискового кэша).
//! Поиск адреса, кэш в `mb_cache` и признак `artists.image` — `nimbus_musicbrainz::artist_image`.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use nimbus_musicbrainz::{artist_image, MbError};
use uuid::Uuid;

use crate::auth::authorize;
use crate::error::ApiError;
use crate::state::AppState;

#[utoipa::path(
    get,
    path = "/api/artist-image/{mbid}",
    tag = "library",
    params(("mbid" = Uuid, Path, description = "MBID артиста")),
    responses(
        (status = 200, description = "Картинка (`image/*`); `Cache-Control: public, max-age=31536000, immutable`"),
        (status = 404, description = "Фото не найдено (`no_image`)", body = crate::error::ErrorResponse),
    )
)]
pub async fn artist_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(mbid): Path<Uuid>,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    let url = artist_image::resolve(&state.db, &state.mb, &state.config.mb_user_agent, mbid)
        .await
        .map_err(|e| match e {
            MbError::NotFound => {
                ApiError::new(StatusCode::NOT_FOUND, "mb_not_found", "artist not found")
            }
            e => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "mb_unavailable",
                e.to_string(),
            ),
        })?;
    let Some(u) = url else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "no_image",
            "no artist image",
        ));
    };
    // Картинку берём один раз и отдаём с нашего origin навсегда (immutable), а не редиректом на внешний адрес.
    crate::image_store::serve(
        &state.config.data_dir,
        &state.config.mb_user_agent,
        &format!("artist-{mbid}"),
        || async move { Ok(Some(u)) },
    )
    .await
}
