# Шаг 05 — Очередь задач, шина событий, WebSocket

**Зависит от:** 04
**Оценка:** 1–1.5 дня

## Цель

1. Надёжная очередь фоновых задач поверх таблицы `jobs` (Postgres, `FOR UPDATE SKIP LOCKED`), с повторами и backoff.
2. Внутрипроцессная шина событий (`tokio::sync::broadcast`).
3. Эндпоинт `GET /api/ws`, транслирующий события клиентам.

## Что сделать

### 1. Типы задач (`core::jobs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum Job {
    DiscoverAlbum  { album_id: i64 },
    DiscoverArtist { artist_id: i64 },
    VerifyTorrent  { torrent_id: i64, album_id: i64 },
    // шаг 22 добавит: PrefetchTrack { track_id: i64 }, EvictCache
}
impl Job {
    pub fn kind(&self) -> &'static str;           // "discover_album", ...
    pub fn dedup_key(&self) -> Option<String>;    // "discover_album:42", "verify_torrent:7:42"
}
```

В БД: `jobs.kind` = `kind()`, `jobs.payload` = JSON payload варианта.

### 2. Репозиторий очереди (`db::repo::jobs`)

- `enqueue(&Job, run_after: Option<DateTime>) -> Option<i64>` — `INSERT ... ON CONFLICT (dedup_key) WHERE state IN ('queued','running') DO NOTHING RETURNING id` (повторная постановка активной задачи — no-op).
- `claim(worker_id, kinds: &[&str]) -> Option<JobRow>`:
  ```sql
  UPDATE jobs SET state='running', locked_at=now(), locked_by=$1, attempts=attempts+1, updated_at=now()
  WHERE id = (
    SELECT id FROM jobs
    WHERE state='queued' AND run_after <= now() AND kind = ANY($2)
    ORDER BY run_after, id
    FOR UPDATE SKIP LOCKED LIMIT 1
  ) RETURNING *;
  ```
- `complete(id)`, `fail(id, error, retry_at: Option<DateTime>)` — если `attempts < max_attempts` и `retry_at` задан → `state='queued', run_after=retry_at`, иначе `state='failed'`.
- `requeue_stale(older_than: Duration)` — задачи `running` дольше N минут (упал процесс) → обратно в `queued`. Вызывать при старте и раз в минуту.
- `purge_done(older_than)` — чистка завершённых старше 7 дней.

### 3. Раннер (`worker` крейт)

```rust
#[async_trait]
pub trait JobHandler: Send + Sync {
    fn kinds(&self) -> &'static [&'static str];
    async fn handle(&self, job: Job, ctx: &JobCtx) -> Result<(), JobError>;
}
pub enum JobError {
    Retry { after: Duration, reason: String },   // временная ошибка
    Fatal(String),                               // не повторять
}
pub struct JobCtx { pub db: PgPool, pub events: EventBus, /* шаги добавят: mb, trackers, torrent */ }
```

- `WorkerPool::spawn(handlers, concurrency_per_kind)`: на каждую группу `kinds` — N tokio-задач, цикл `claim → handle → complete/fail`. Если задач нет — ждать `PgListener` на канале `jobs` **или** sleep 1s (достаточно: `enqueue` делает `NOTIFY jobs` — реализуй через `pg_notify` в той же транзакции и `sqlx::postgres::PgListener` в раннере, с fallback-поллингом раз в 5 с).
- Backoff по умолчанию для неожиданных ошибок (`anyhow`/panic): `30s * 2^(attempts-1)`, максимум 30 мин.
- Паника в handler не должна убивать воркер (`tokio::spawn` + `JoinHandle` или `catch_unwind` через `FutureExt`).
- Graceful shutdown: по сигналу перестать брать новые задачи, дождаться текущих (таймаут 10 с).
- Параллелизм по умолчанию: `discover_*` — 2, `verify_torrent` — 4.
- На этом шаге зарегистрировать **заглушки** handler-ов `DiscoverAlbum`/`DiscoverArtist`/`VerifyTorrent`, которые логируют и завершаются успешно (реальную логику дадут шаги 14 и 17).

### 4. Шина событий (`core::events`)

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "track.status")]
    TrackStatus { track_id: i64, album_id: i64, status: TrackStatus, reason: Option<String> },
    #[serde(rename = "job.progress")]
    JobProgress { album_id: i64, stage: JobStage, done: u32, total: u32 },   // stage: searching | verifying
    #[serde(rename = "stream.progress")]
    StreamProgress { track_id: i64, bytes_done: u64, bytes_total: u64, peers: u32, down_speed_bps: u64 },
    #[serde(rename = "library.changed")]
    LibraryChanged { entity: Entity, id: i64 },                              // entity: artist | album | track
}
#[derive(Clone)]
pub struct EventBus(broadcast::Sender<Event>);   // capacity 1024
impl EventBus { pub fn publish(&self, e: Event); pub fn subscribe(&self) -> broadcast::Receiver<Event>; }
```

Удобный хелпер в `db`/`worker`: `set_track_status_and_publish(db, events, track_id, status, reason)`.

### 5. WebSocket `GET /api/ws`

- axum `WebSocketUpgrade`. На подключение — `events.subscribe()`, каждое событие → JSON текстовое сообщение.
- Ping от сервера каждые 25 с; закрывать соединение, если клиент не отвечает 60 с.
- При `RecvError::Lagged(n)` — отправить `{"type":"resync"}` (клиент перезапросит данные) и продолжить.
- Входящие сообщения клиента на этом шаге игнорировать (кроме close/pong).
- (Авторизацию добавит шаг 23 — оставь место: функция-гард, сейчас пропускающая всех.)

### 6. Отладочный эндпоинт

`GET /api/debug/jobs?state=&limit=50` — список задач (только если `cfg!(debug_assertions)` или `NIMBUS_DEBUG=true`). Пригодится в следующих шагах.

### 7. Встроить в `main.rs`

`AppState` получает `events: EventBus`. Запуск `WorkerPool` в том же процессе, что и API (один бинарник).

## Тесты

- `#[sqlx::test]`: enqueue с одинаковым dedup_key → одна активная задача; после `complete` — можно поставить снова.
- Два конкурентных `claim` не получают одну задачу.
- `fail` с ретраем → `queued` с `run_after` в будущем; после `max_attempts` → `failed`.
- `requeue_stale` возвращает зависшие задачи.
- Раннер: тестовый handler, который падает 2 раза и потом успешен → задача `done`, `attempts=3` (используй маленький backoff через параметр).
- WS: интеграционный тест — поднять сервер на случайном порту, подключиться `tokio-tungstenite`, опубликовать событие, получить JSON с `"type":"track.status"`.

## Критерии приёмки

- `just backend-test`, `just backend-check` проходят.
- Ручная проверка: `websocat ws://localhost:8080/api/ws` (или тест) получает события; `curl localhost:8080/api/debug/jobs` отвечает.

## Вне рамок шага

Реальные обработчики задач.
