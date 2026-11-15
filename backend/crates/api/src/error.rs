use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

/// Тело ошибки: `{ "error": { "code": "...", "message": "..." } }`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorResponse {
    pub error: ErrorBody,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    /// Путь поля запроса, к которому относится ошибка валидации (`musicbrainz.burst`), если он известен.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub field: Option<String>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            field: None,
        }
    }

    /// Привязывает ошибку к полю запроса (путь через точку).
    pub fn with_field(mut self, field: impl Into<String>) -> Self {
        self.field = Some(field.into());
        self
    }

    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal server error",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(ErrorResponse {
            error: ErrorBody {
                code: self.code,
                message: self.message,
                field: self.field,
            },
        });
        (self.status, body).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        // БД недоступна (остановлена, сеть, исчерпан пул) — это не баг обработчика: 503, клиент повторит позже.
        if matches!(
            e,
            sqlx::Error::Io(_)
                | sqlx::Error::Tls(_)
                | sqlx::Error::PoolTimedOut
                | sqlx::Error::PoolClosed
                | sqlx::Error::WorkerCrashed
        ) {
            tracing::warn!(error = %e, "database unavailable");
            return Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "db_unavailable",
                "database is unavailable",
            );
        }
        tracing::error!(error = %e, "database error");
        Self::internal()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = ?e, "internal error");
        Self::internal()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreachable_database_is_503_and_other_errors_are_500() {
        let down = ApiError::from(sqlx::Error::PoolTimedOut);
        assert_eq!(down.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(down.code, "db_unavailable");
        let io = ApiError::from(sqlx::Error::Io(std::io::Error::other("refused")));
        assert_eq!(io.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            ApiError::from(sqlx::Error::RowNotFound).status,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
