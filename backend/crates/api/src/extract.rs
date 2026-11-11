use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::Json;
use serde::de::DeserializeOwned;

use crate::error::ApiError;

/// `Json<T>` с ошибками разбора в формате API: `400 { "error": { "code": "bad_request", ... } }`.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(v)) => Ok(Self(v)),
            Err(
                rej @ JsonRejection::JsonDataError(_)
                | rej @ JsonRejection::JsonSyntaxError(_)
                | rej @ JsonRejection::MissingJsonContentType(_),
            ) => Err(ApiError::bad_request("bad_request", rej.body_text())),
            Err(other) => Err(ApiError::bad_request("bad_request", other.body_text())),
        }
    }
}
