//! Настройки, проверка провайдеров и учёт хранилища.

use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use nimbus_core::model::TorrentSource;
use nimbus_core::settings::{mask_secrets, merge_patch, ProvidersSettings, Settings};
use nimbus_db::settings::SettingsError;
use nimbus_trackers::registry::build_providers;
use nimbus_trackers::SearchQuery;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::auth::authorize;
use crate::error::{ApiError, ErrorResponse};
use crate::extract::ApiJson;
use crate::state::AppState;

/// Применяет настройки к работающим компонентам: провайдеры и политика раздачи.
pub async fn apply_settings(state: &AppState, settings: &Settings) -> Result<(), ApiError> {
    state
        .providers
        .reload(&settings.providers)
        .map_err(|e| ApiError::bad_request("invalid_settings", format!("providers: {e}")))?;
    if let Some(engine) = &state.engine {
        engine.set_seeding(settings.storage.seeding).await;
        engine.set_seed_ratio(settings.storage.seed_ratio).await;
    }
    Ok(())
}

#[utoipa::path(
    get,
    path = "/api/settings",
    tag = "settings",
    responses((status = 200, description = "Текущие настройки; заданные секреты заменены на «••••»", body = Object))
)]
pub async fn get_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers)?;
    Ok(Json(mask_secrets(&state.settings.get())))
}

#[utoipa::path(
    put,
    path = "/api/settings",
    tag = "settings",
    request_body(content = Object, description = "Частичный объект настроек (merge). Пустой секрет или «••••» не меняет сохранённое значение; `null` сбрасывает необязательное поле."),
    responses(
        (status = 200, description = "Сохранённые настройки (секреты замаскированы)", body = Object),
        (status = 400, description = "Некорректные значения (`invalid_settings`)", body = ErrorResponse),
    )
)]
pub async fn put_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(patch): ApiJson<Value>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers)?;
    // Сначала проверяем слияние и сборку провайдеров, чтобы не сохранить заведомо нерабочие настройки.
    let merged = merge_patch(&state.settings.get(), &patch)
        .map_err(|e| ApiError::bad_request("invalid_settings", e))?;
    build_providers(&merged.providers)
        .map_err(|e| ApiError::bad_request("invalid_settings", format!("providers: {e}")))?;
    let saved = state.settings.update(&patch).await.map_err(|e| match e {
        SettingsError::Invalid(m) => ApiError::bad_request("invalid_settings", m),
        SettingsError::Db(e) => e.into(),
    })?;
    apply_settings(&state, &saved).await?;
    Ok(Json(mask_secrets(&saved)))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProviderName {
    Tpb,
    Rutracker,
    Torznab,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ProviderTestRequest {
    pub provider: ProviderName,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ProviderTestResponse {
    pub ok: bool,
    pub message: String,
    pub sample_count: usize,
}

const TEST_TIMEOUT: Duration = Duration::from_secs(25);

#[utoipa::path(
    post,
    path = "/api/settings/providers/test",
    tag = "settings",
    request_body = ProviderTestRequest,
    responses(
        (status = 200, description = "Результат пробного поиска «Radiohead» (ok=false — провайдер не ответил или отклонил логин)", body = ProviderTestResponse),
        (status = 400, description = "Провайдер не настроен (`not_configured`)", body = ErrorResponse),
    )
)]
pub async fn test_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(req): ApiJson<ProviderTestRequest>,
) -> Result<Json<ProviderTestResponse>, ApiError> {
    authorize(&state, &headers)?;
    let current = state.settings.get();
    // Проверяем только выбранный провайдер (TPB — даже если он выключен в настройках).
    let only = match req.provider {
        ProviderName::Tpb => ProvidersSettings {
            tpb_enabled: true,
            torznab: None,
            rutracker: None,
        },
        ProviderName::Torznab => ProvidersSettings {
            tpb_enabled: false,
            torznab: current.providers.torznab.clone(),
            rutracker: None,
        },
        ProviderName::Rutracker => ProvidersSettings {
            tpb_enabled: false,
            torznab: None,
            rutracker: current.providers.rutracker.clone(),
        },
    };
    let wanted = match req.provider {
        ProviderName::Tpb => TorrentSource::Tpb,
        ProviderName::Torznab => TorrentSource::Torznab,
        ProviderName::Rutracker => TorrentSource::Rutracker,
    };
    let providers = build_providers(&only)
        .map_err(|e| ApiError::bad_request("not_configured", e.to_string()))?;
    let Some(provider) = providers.into_iter().find(|p| p.source() == wanted) else {
        return Err(ApiError::bad_request(
            "not_configured",
            "provider is not configured (missing URL or credentials)",
        ));
    };
    let query = SearchQuery::text("Radiohead");
    let res = tokio::time::timeout(TEST_TIMEOUT, provider.search(&query)).await;
    Ok(Json(match res {
        Ok(Ok(found)) => ProviderTestResponse {
            ok: true,
            message: format!("Найдено раздач: {}", found.len()),
            sample_count: found.len(),
        },
        Ok(Err(e)) => ProviderTestResponse {
            ok: false,
            message: e.to_string(),
            sample_count: 0,
        },
        Err(_) => ProviderTestResponse {
            ok: false,
            message: "Провайдер не ответил вовремя".into(),
            sample_count: 0,
        },
    }))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReimportResponse {
    /// Сколько артистов поставлено на повторный импорт дискографии.
    pub queued: usize,
}

#[utoipa::path(
    post,
    path = "/api/settings/reimport-artists",
    tag = "settings",
    responses((status = 200, description = "Повторный импорт дискографий всех артистов библиотеки поставлен в очередь (уже имеющиеся альбомы не дублируются)", body = ReimportResponse))
)]
pub async fn reimport_artists(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ReimportResponse>, ApiError> {
    authorize(&state, &headers)?;
    let ids = nimbus_db::repo::artists::library_artist_ids(&state.db).await?;
    for id in &ids {
        state.library.enqueue_import(*id).await?;
    }
    Ok(Json(ReimportResponse { queued: ids.len() }))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct StorageDto {
    pub used_bytes: u64,
    pub limit_bytes: u64,
    /// Файлов в кэше (на диске).
    pub files: i64,
    /// Торрентов с незавершёнными загрузками.
    pub torrents_active: i64,
}

#[utoipa::path(
    get,
    path = "/api/storage",
    tag = "settings",
    responses((status = 200, description = "Занятое место кэша и лимит", body = StorageDto))
)]
pub async fn get_storage(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<StorageDto>, ApiError> {
    authorize(&state, &headers)?;
    let u = nimbus_worker::cache::usage(&state.db).await?;
    Ok(Json(StorageDto {
        used_bytes: u.used_bytes,
        limit_bytes: state.settings.get().cache_limit_bytes(),
        files: u.files,
        torrents_active: u.torrents_active,
    }))
}
