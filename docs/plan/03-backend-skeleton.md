# Шаг 03 — Каркас Rust-бэкенда

**Зависит от:** 01
**Оценка:** 1 день

## Цель

Cargo workspace со всеми крейтами (пока почти пустыми), бинарник `nimbus` на axum с `/api/health`, конфиг из env, логирование, пул sqlx и запуск миграций при старте, CORS, единый формат ошибок. Dockerfile.

## Что сделать

1. `backend/Cargo.toml` — workspace:
   ```toml
   [workspace]
   resolver = "2"
   members = ["crates/*"]

   [workspace.package]
   edition = "2021"
   version = "0.1.0"

   [workspace.dependencies]
   tokio = { version = "1", features = ["full"] }
   axum = { version = "0.8", features = ["ws", "macros"] }
   tower = "0.5"
   tower-http = { version = "0.6", features = ["cors", "trace", "fs"] }
   serde = { version = "1", features = ["derive"] }
   serde_json = "1"
   sqlx = { version = "0.8", features = ["runtime-tokio", "tls-rustls", "postgres", "uuid", "chrono", "json", "migrate"] }
   uuid = { version = "1", features = ["serde", "v4"] }
   chrono = { version = "0.4", features = ["serde"] }
   thiserror = "2"
   anyhow = "1"
   tracing = "0.1"
   tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt"] }
   reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls", "cookies", "gzip", "socks"] }
   async-trait = "0.1"
   futures = "0.3"
   wiremock = "0.6"
   ```
   (Версии — актуальные на момент выполнения; если мажорные изменились, используй свежие и поправь код.)
2. Крейты (`cargo new --lib` для всех кроме `api`):
   - `crates/core` — доменные типы (наполнит шаг 04), `Config`.
   - `crates/db` — пул, миграции, репозитории (шаг 04).
   - `crates/musicbrainz` — клиент MB (шаг 06).
   - `crates/trackers` — провайдеры торрентов (шаги 12–13).
   - `crates/matcher` — сопоставление (шаг 16).
   - `crates/torrent` — обёртка librqbit (шаг 15).
   - `crates/worker` — исполнители задач (шаги 05, 14, 17).
   - `crates/api` — **бинарник** `nimbus` (`[[bin]] name = "nimbus"`), axum-роутер.
3. `core::config::Config` — читается из env (используй `envy` или ручной разбор; `dotenvy` для `.env` из корня репо в dev):
   ```rust
   pub struct Config {
       pub database_url: String,
       pub bind: SocketAddr,              // NIMBUS_BIND
       pub data_dir: PathBuf,             // NIMBUS_DATA_DIR
       pub mb_user_agent: String,         // NIMBUS_MB_USER_AGENT
       pub cors_origin: String,           // NIMBUS_CORS_ORIGIN
       pub tpb_enabled: bool,
       pub torznab_url: Option<String>,
       pub torznab_api_key: Option<String>,
       pub rutracker_username: Option<String>,
       pub rutracker_password: Option<String>,
       pub rutracker_cookie: Option<String>,
       pub rutracker_proxy: Option<String>,
       pub cache_limit_gb: u64,
       pub seeding: bool,
       pub api_token: Option<String>,
   }
   ```
   Все поля и дефолты — из таблицы в `PLAN.md`. Пустая строка в env = `None`.
4. `db` крейт: `pub async fn connect(url) -> PgPool` (max 10 соединений) и `pub async fn migrate(&PgPool)` через `sqlx::migrate!("../../migrations")`. Каталог `backend/migrations/` с первой пустой миграцией `0001_init.sql` (`SELECT 1;`) — шаг 04 заменит содержимое (до первого релиза можно редактировать `0001`, но лучше добавлять `0002_...`).
5. `api` крейт:
   - `main.rs`: init tracing (`RUST_LOG`, по умолчанию `info,nimbus=debug,sqlx=warn`), загрузка конфига, создание `data_dir`, подключение к БД, миграции, сборка `AppState`, запуск сервера, graceful shutdown по Ctrl+C/SIGTERM.
   - `AppState { db: PgPool, config: Arc<Config> }` (`Clone`), дальше шаги будут добавлять поля.
   - Роутер `Router::new().nest("/api", api_routes())` с `TraceLayer` и `CorsLayer` (origin = `cors_origin`, методы GET/POST/PUT/DELETE, заголовки `content-type, authorization, range`, expose `content-range, accept-ranges, content-length`).
   - `GET /api/health` → `{"status":"ok","db":true,"version":"0.1.0"}` (делает `SELECT 1`).
   - `error.rs`: `ApiError { status, code, message }` + `impl IntoResponse` → `{"error":{"code","message"}}`; `From<sqlx::Error>`, `From<anyhow::Error>` → 500 с логированием.
6. `backend/Dockerfile` — multi-stage (`rust:1-bookworm` → `debian:bookworm-slim` + `ca-certificates` + `ffmpeg`), бинарник `nimbus`, `EXPOSE 8080`.
7. `justfile` — добавить:
   ```make
   backend:
       cd backend && cargo run -p api --bin nimbus
   backend-test:
       cd backend && cargo test --workspace
   backend-check:
       cd backend && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
   test: backend-test
   check: backend-check web-check
   ```
   (`web-check` из шага 02; если шаг 02 ещё не сделан — `check` пока только `backend-check`.)

## Тесты

- Unit-тест разбора конфига (env → Config, пустые строки → None, дефолты).
- Интеграционный тест `/api/health` через `tower::ServiceExt::oneshot` с `#[sqlx::test]` (нужен `DATABASE_URL`).

## Критерии приёмки

- `just db-up && just backend` → `curl -s localhost:8080/api/health` отдаёт `{"status":"ok","db":true,...}`.
- `just backend-test` и `just backend-check` проходят.
- `docker build backend` собирается (если Docker доступен).

## Вне рамок шага

Схема БД, доменная логика.
