use axum::http::HeaderMap;

use crate::error::ApiError;
use crate::state::AppState;

/// Гард доступа. Сейчас пропускает всех; шаг 23 добавит проверку `NIMBUS_API_TOKEN`.
pub fn authorize(_state: &AppState, _headers: &HeaderMap) -> Result<(), ApiError> {
    Ok(())
}
