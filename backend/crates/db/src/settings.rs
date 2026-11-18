//! Хранилище настроек: запись `key = 'settings'` в БД + копия в памяти с подпиской на изменения.

use std::sync::Arc;

use nimbus_core::settings::{merge_patch, Settings};
use serde_json::Value;
use sqlx::PgPool;
use tokio::sync::{watch, Mutex};

const KEY: &str = "settings";

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("{0}")]
    Invalid(String),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

#[derive(Clone)]
pub struct SettingsStore {
    pool: PgPool,
    tx: Arc<watch::Sender<Arc<Settings>>>,
    write_lock: Arc<Mutex<()>>,
    /// Значения из окружения: для полей с «пусто = как в окружении» (`Settings::with_env_fallbacks`).
    env: Arc<Settings>,
}

impl SettingsStore {
    /// Хранилище со значениями по умолчанию, без чтения БД (запись при первом `update`).
    pub fn new(pool: PgPool, defaults: Settings) -> Self {
        Self::with_current(pool, defaults.clone(), defaults)
    }

    fn with_current(pool: PgPool, current: Settings, env: Settings) -> Self {
        let current = current.with_env_fallbacks(&env);
        let (tx, _) = watch::channel(Arc::new(current));
        Self {
            pool,
            tx: Arc::new(tx),
            write_lock: Arc::new(Mutex::new(())),
            env: Arc::new(env),
        }
    }

    /// Читает сохранённые настройки; отсутствующие поля берутся из `defaults` (serde `default`).
    pub async fn load(pool: PgPool, defaults: Settings) -> Result<Self, sqlx::Error> {
        let row: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
            .bind(KEY)
            .fetch_optional(&pool)
            .await?;
        let settings = match row {
            Some(v) => {
                // Сохранённое поверх env-дефолтов: сливаем как патч, чтобы пропавшие поля не сбрасывались.
                merge_patch(&defaults, &v).unwrap_or_else(|e| {
                    tracing::warn!(error = %e, "stored settings are invalid, using defaults");
                    defaults.clone()
                })
            }
            None => defaults.clone(),
        };
        Ok(Self::with_current(pool, settings, defaults))
    }

    pub fn get(&self) -> Arc<Settings> {
        self.tx.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<Arc<Settings>> {
        self.tx.subscribe()
    }

    /// Сливает патч, проверяет, сохраняет в БД и публикует новое значение.
    pub async fn update(&self, patch: &Value) -> Result<Arc<Settings>, SettingsError> {
        let _guard = self.write_lock.lock().await;
        let merged = merge_patch(&self.get(), patch)
            .map_err(SettingsError::Invalid)?
            .with_env_fallbacks(&self.env);
        let value = serde_json::to_value(&merged).expect("Settings serializes");
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(KEY)
        .bind(value)
        .execute(&self.pool)
        .await?;
        let merged = Arc::new(merged);
        self.tx.send_replace(merged.clone());
        Ok(merged)
    }
}

const RUNTIME_KEY: &str = "runtime";

/// Глобальная пауза загрузок (`settings.runtime.downloads_paused`): отдельный ключ, не часть
/// конфигурации, переживает рестарт.
pub async fn downloads_paused(pool: &PgPool) -> sqlx::Result<bool> {
    let v: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(RUNTIME_KEY)
        .fetch_optional(pool)
        .await?;
    Ok(
        v.and_then(|v| v.get("downloads_paused").and_then(Value::as_bool))
            .unwrap_or(false),
    )
}

pub async fn set_downloads_paused(pool: &PgPool, paused: bool) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ($1, jsonb_build_object('downloads_paused', $2::boolean))
         ON CONFLICT (key) DO UPDATE SET
            value = settings.value || jsonb_build_object('downloads_paused', $2::boolean),
            updated_at = now()",
    )
    .bind(RUNTIME_KEY)
    .bind(paused)
    .execute(pool)
    .await?;
    Ok(())
}

/// Версия, на которой процесс запускался в прошлый раз (`settings.runtime.last_version`).
pub async fn last_version(pool: &PgPool) -> sqlx::Result<Option<String>> {
    let v: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(RUNTIME_KEY)
        .fetch_optional(pool)
        .await?;
    Ok(v.and_then(|v| {
        v.get("last_version")
            .and_then(Value::as_str)
            .map(String::from)
    }))
}

pub async fn set_last_version(pool: &PgPool, version: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ($1, jsonb_build_object('last_version', $2::text))
         ON CONFLICT (key) DO UPDATE SET
            value = settings.value || jsonb_build_object('last_version', $2::text),
            updated_at = now()",
    )
    .bind(RUNTIME_KEY)
    .bind(version)
    .execute(pool)
    .await?;
    Ok(())
}
