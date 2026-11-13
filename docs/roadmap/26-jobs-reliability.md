# Шаг 26 — Очередь задач: heartbeat, восстановление, приоритеты, исчерпание попыток

**Фаза 1 · Зависит от:** 25 · **Закрывает находки:** J1–J6

## Зачем

Очередь — позвоночник конвейера «импорт → поиск → проверка → загрузка». Сейчас долгая задача может
быть запущена дважды, упавшая навсегда оставляет альбом в `adding`, а рестарт сервера на 10 минут
замораживает всё, что выполнялось. После шага очередь переживает падение процесса, отмену и исчерпание
попыток без потери и без дублей, а параллелизм и порядок управляются настройками и приоритетом.

## Текущее состояние (прочитай перед началом)

- `backend/crates/db/src/repo/jobs.rs` — `enqueue`, `claim` (`ORDER BY run_after, id … SKIP LOCKED`), `complete`, `fail`, `requeue_stale`, `purge_done`, `defer_queued_verifies`, `has_queued_discover`.
- `backend/crates/worker/src/runner.rs` — `JobCtx`, `JobError`, `JobHandler`, `WorkerConfig` (`stale_after` 10 мин, `shutdown_timeout` 10 с), `WorkerPool::spawn`, `worker_loop`, `process`.
- `backend/crates/worker/src/handlers.rs` — `default_handlers()` с зашитым параллелизмом.
- `backend/crates/core/src/jobs.rs` — `enum Job`, `dedup_key`.
- `backend/crates/core/src/settings.rs` — `Settings` (разделы `providers`, `search`, `matching`, `playback`, `storage`), `validate`, `merge_patch`.
- `backend/crates/db/src/lib.rs` — пул `max_connections(10)`.
- `backend/crates/api/src/main.rs` — запуск `WorkerPool`, порядок shutdown.
- Тесты: `crates/db/tests/jobs.rs`, `crates/worker/tests/runner.rs`.
- Схема `jobs` — `backend/migrations/0002_schema.sql`, `0005_job_progress.sql`.

## Что сделать

1. **Миграция `0007_jobs_reliability.sql`:**
   - `ALTER TABLE jobs ADD COLUMN priority SMALLINT NOT NULL DEFAULT 0;` (больше — раньше);
   - `ALTER TABLE jobs ADD COLUMN heartbeat_at TIMESTAMPTZ;`
   - индекс под claim: `CREATE INDEX jobs_claim_idx ON jobs (priority DESC, run_after, id) WHERE state = 'queued';` (старый `jobs_ready_idx` удалить).
2. **Приоритеты.** Константы в `core::jobs`: `PRIORITY_INTERACTIVE = 10` (пользователь нажал: добавить альбом/трек, retry, свой magnet),
   `PRIORITY_NORMAL = 0` (массовый импорт), `PRIORITY_BACKGROUND = -10` (резервные источники, авто-повторы, вытеснение кэша).
   `jobs::enqueue` получает структуру опций `EnqueueOpts { run_after, max_attempts, priority }` (с `Default`);
   обнови все вызовы. `claim`: `ORDER BY priority DESC, run_after, id`. Если задача с тем же `dedup_key`
   уже `queued`, а новая приоритетнее — поднять приоритет существующей (`ON CONFLICT … DO UPDATE SET priority = GREATEST(...)` только для `state = 'queued'`).
   Вызовы из API (`library.rs`, `sources.rs`) ставят `PRIORITY_INTERACTIVE`; из `import_artist` — `NORMAL`.
   `defer_queued_verifies` заменить на понижение приоритета до `BACKGROUND` (без сдвига `run_after`);
   константу `LOW_PRIORITY_DELAY` и её использование в `discover.rs`/`verify.rs` удалить.
3. **Heartbeat.** Пока обработчик выполняется, раннер каждые `heartbeat_interval` (по умолчанию 15 с)
   обновляет `heartbeat_at = now()` для своей задачи (отдельная задача tokio, отменяется по завершении обработчика).
   `claim` выставляет `heartbeat_at = now()`. `requeue_stale` смотрит на `heartbeat_at` (а не `locked_at`),
   `stale_after` по умолчанию — 90 с.
4. **Восстановление при старте.** `WorkerPool::spawn` (или отдельная `jobs::recover_orphans`) до запуска
   воркеров возвращает в `queued` **все** задачи `running` (в процессе один экземпляр воркеров; зафиксируй
   это допущение doc-комментарием) и **возвращает попытку** (`attempts = GREATEST(attempts - 1, 0)`), `run_after = now()`.
5. **Отмена и остановка.** В `JobCtx` добавить `cancel: CancellationToken` (дочерний от токена пула).
   Обработчики, которые ждут сеть (`verify`, `discover`, `import`), должны завершаться по отмене:
   оберни ожидания в `tokio::select!` с `ctx.cancel.cancelled()` и возвращай новый вариант
   `JobError::Cancelled`. Раннер на `Cancelled`: вернуть задачу в `queued` без траты попытки.
   `WorkerPool::shutdown`: отменить токен → ждать `shutdown_timeout` → оставшиеся задачи `abort()` и
   вернуть их строки в `queued` (тем же запросом, что в п. 4, но по `locked_by` этого процесса).
6. **Хук исчерпания попыток.** В `JobHandler` добавить метод с реализацией по умолчанию:
   ```rust
   /// Вызывается один раз, когда задача окончательно стала `failed`. Должен привести данные
   /// в согласованное состояние (ничего не должно навсегда остаться «в процессе»).
   async fn on_exhausted(&self, job: &Job, ctx: &JobCtx, reason: &str) -> Result<(), JobError> { Ok(()) }
   ```
   Раннер вызывает его, когда `jobs::fail` вернул `state = 'failed'` (и для `Fatal`), а `requeue_stale`
   должен возвращать список задач, ставших `failed`, чтобы обслуживающий цикл тоже вызвал хук.
   Реализации:
   - `VerifyHandler`: `album_torrents::mark_verified`, если метаданные так и не получены — `meta_status = error`, затем `finalize_album`;
   - `DiscoverHandler` (`discover_album`): если у альбома нет ни одной привязанной раздачи — треки `adding → not_found` с причиной `search_failed` (добавь вариант в `NotFoundReason`); иначе `finalize_album`;
   - `ProcessCueHandler`: пометить кандидата обработанным с ошибкой и вызвать `finalize_album`;
   - `ImportArtistHandler`: опубликовать `library.changed` (сейчас это делается в `process` — перенеси сюда и убери спец-ветку из раннера).
7. **Параллелизм из настроек.** В `Settings` добавить раздел
   `performance { discover_workers: u8 = 8, verify_workers: u8 = 16, import_workers: u8 = 2 }` с валидацией `1..=64`.
   `default_handlers()` → `handlers(&PerformanceSettings)`. Значения читаются при старте; изменение
   требует рестарта — верни это в ответе `PUT /api/settings` полем `restart_required: bool` (true, если изменился `performance`).
   Пул БД: `max_connections = 10 + discover + verify + import` (минимум 20), `acquire_timeout` 30 с.
   > Поля `metadata_concurrency`, `metadata_timeout_secs`, `download_concurrency` добавят шаги 28 и 33 — не добавляй их здесь.
8. **API задач** (штатный, не debug): в `crates/api/src/jobs.rs`
   - `GET /api/jobs?state=&kind=&limit=` → `{ jobs: [JobDto], counts: { queued, running, failed } }`;
     `JobDto { id, kind, payload, state, attempts, max_attempts, priority, run_after, last_error, updated_at }`;
   - `POST /api/jobs/{id}/retry` — только для `failed`: `state = 'queued'`, `attempts = 0`, `run_after = now()`, приоритет `INTERACTIVE`; 409, если задача не `failed` или активен дубликат по `dedup_key`.
   Оба — с `authorize`, в OpenAPI. `/api/debug/jobs` оставить.
9. **Обновить контракты:** `just web-gen-api` (типы старого фронтенда), `docs/api.md`, `docs/architecture.md` (раздел «Очередь задач»).

## Тесты (обязательные)

`crates/db/tests/jobs.rs`:
- claim выбирает по приоритету, затем по `run_after`; повторный enqueue с бо́льшим приоритетом поднимает приоритет ожидающей задачи;
- `requeue_stale` не трогает задачу со свежим `heartbeat_at` и возвращает задачу с протухшим; исчерпавшая попытки → `failed` и присутствует в возвращаемом списке;
- `recover_orphans` возвращает `running` в `queued` и возвращает попытку.

`crates/worker/tests/runner.rs` (фейковые обработчики, `WorkerConfig` с миллисекундными интервалами):
- долгий обработчик (дольше `stale_after`) **не** запускается второй раз — heartbeat держит задачу;
- shutdown во время выполнения: обработчик получает отмену, задача снова `queued`, `attempts` не увеличился;
- обработчик, игнорирующий отмену: после `shutdown_timeout` задача `queued`;
- `on_exhausted` вызывается ровно один раз при исчерпании попыток и при `Fatal`; не вызывается при успешном повторе;
- паника в обработчике → повтор с backoff (как раньше).

`crates/worker/tests/verify.rs`, `discover.rs`:
- verify, падающий `Unexpected` до исчерпания попыток → раздача помечена проверенной, треки альбома `not_found` (а не вечный `adding`);
- discover с вечной ошибкой БД/провайдера → `not_found` с причиной `search_failed`.

`crates/api/tests/jobs.rs`: список с фильтрами и счётчиками; retry `failed` → `queued`; retry не-`failed` → 409; 401 без токена.
`crates/api/tests/settings.rs`: `performance` валидируется; `restart_required`.

## Критерии приёмки

```
just db-up && just check && just test && just cov
just openapi && just web-gen-api && just web-check
grep -n "LOW_PRIORITY_DELAY" -r backend/crates && exit 1 || true
```

## Не входит в шаг

- Удаление `ALBUM_JOB_STAGGER`/`VERIFY_STAGGER` и перестройка конвейера (шаг 29).
- Автоповтор поиска не найденного (шаг 32).

## Подводные камни

- `ON CONFLICT (dedup_key) WHERE state IN ('queued','running')` — частичный уникальный индекс; `DO UPDATE` должен менять приоритет только у `queued` (условие в `WHERE` обновления).
- Heartbeat-задача должна завершаться **до** `complete`/`fail`, иначе она может «оживить» уже завершённую строку: в запросе heartbeat ставь условие `state = 'running' AND locked_by = $worker`.
- Возврат попытки при восстановлении не должен делать задачу бессмертной: «ядовитая» задача, роняющая процесс, отлавливается тем, что `attempts` растёт при каждом claim, а возвращается только при штатном рестарте/отмене — оставь `requeue_stale` (аварийный путь) без возврата попытки.
- `finalize_album` опирается на `jobs::has_queued_discover` — после изменения `enqueue` убедись, что проверка по-прежнему видит `queued` и `running`.
