# B05 — Упавшие `import_artist` / `discover_artist` никогда не перезапускаются

**Приоритет:** P1 · **Область:** `backend/crates/db` (`jobs.rs`), `backend/crates/worker` (`runner.rs`) · **Зависит от:** —

## Проблема

Задача, исчерпавшая попытки, получает `failed` и остаётся такой до ручного `POST /api/jobs/{id}/retry`.
Для `discover_album` / `verify_torrent` / `process_cue` это не страшно: `on_exhausted` приводит данные в порядок,
а альбом дальше ведёт `RetryMissing`. Но у двух видов задач **другого пути повтора нет**:

- `import_artist` — `IMPORT_MAX_ATTEMPTS = 8`, паузы 30 с, 1, 2, 4, 8, 10, 10 мин: MusicBrainz, недоступный
  дольше ≈ 35 минут (или зависший импорт несколько раз подряд), оставляет артиста недоимпортированным навсегда.
- `discover_artist` — поиск дискографий: после исчерпания (`search_failed`) дискографии артиста больше не ищутся;
  `RetryMissing` повторяет только альбомные запросы.

Кроме того, строки `failed` никогда не удаляются (`purge_done` чистит только `done`).

## Текущее состояние (прочитай перед началом)

- `backend/crates/db/src/repo/jobs.rs` — `fail`, `defer`, `requeue_stale`, `retry`, `purge_done`, `JobRow`.
- `backend/crates/worker/src/runner.rs` — `process` (разбор `JobError`), `maintenance_loop`, `exhausted`, `WorkerConfig`.
- `backend/crates/worker/src/handlers.rs` — `ImportArtistHandler` (`on_retry`, `on_exhausted`).
- `backend/crates/library/src/service.rs` — `enqueue_import`, `IMPORT_MAX_ATTEMPTS`.
- `backend/crates/api/src/jobs.rs` — список и ручной повтор; `backend/crates/api/tests/jobs.rs`.
- Тесты: `backend/crates/db/tests/jobs.rs`, `backend/crates/worker/tests/runner.rs`.

## Что сделать

### 1. Схема

Миграция `0013_job_revival.sql` (номер — следующий свободный):

```sql
-- `fatal` — задача провалена окончательно (повтор бессмыслен); `revivals` — сколько раз её оживляло обслуживание.
ALTER TABLE jobs ADD COLUMN fatal BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN revivals INT NOT NULL DEFAULT 0;
CREATE INDEX jobs_failed_idx ON jobs (kind, updated_at) WHERE state = 'failed';
```

Существующие `failed` получают `fatal = FALSE` — т. е. будут оживлены (это и нужно).

### 2. Признак «окончательно»

- `jobs::fail(db, id, error, retry_at)` получает параметр `fatal: bool`; пишет его только при переходе в `failed`.
- `runner::process`: `JobError::Fatal` и «bad payload» → `fatal = true`; исчерпание попыток (`Retry`, `Unexpected`,
  паника), `defer` по возрасту, `requeue_stale` → `fatal = false`.
- `JobRow` получает оба поля; API-ответ списка задач (`api/src/jobs.rs`) — поле `fatal` (обновить OpenAPI,
  `client/openapi.json`, `bun run gen:api`, `docs/api.md`).

### 3. Оживление

`jobs::revive_failed(db, kinds: &[&str], delays: &[Duration]) -> Vec<JobRow>`:

```sql
UPDATE jobs j SET state = 'queued', attempts = 0, run_after = now(), revivals = revivals + 1,
                  priority = LEAST(priority, 0), updated_at = now()
WHERE j.state = 'failed' AND NOT j.fatal AND j.kind = ANY($1)
  AND j.updated_at < now() - <пауза по j.revivals>
  -- только последняя задача с этим ключом и только если нет активной такой же
  AND j.id = (SELECT max(id) FROM jobs x WHERE x.dedup_key = j.dedup_key)
  AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.dedup_key = j.dedup_key AND a.state IN ('queued','running'))
RETURNING j.*
```

Пауза по `revivals`: 15 мин, 1 ч, 6 ч, далее 24 ч (последнее значение массива повторяется) — передавать массивом
секунд и выбирать через `(ARRAY[...])[LEAST(revivals + 1, n)]`. После `UPDATE` — `pg_notify('jobs', …)`.
Попытки обнуляются: оживлённая задача проходит обычный цикл повторов заново.

`maintenance_loop`: раз в тик вызывать `revive_failed` для `[Job::IMPORT_ARTIST, Job::DISCOVER_ARTIST]`
(список — константа `REVIVABLE_KINDS` с комментарием, почему остальные виды не входят: у них повтор на уровне
альбома). Для каждой оживлённой строки вызвать `handler.on_retry(&job, &ctx, "revived")` — у `import_artist`
это публикует `LibraryChanged` артиста, интерфейс увидит «импорт идёт». Паузы — в `WorkerConfig`
(`revive_delays`, в тестах малые).

Ручной повтор (`jobs::retry`) дополнительно сбрасывает `fatal = FALSE` и `revivals = 0`.

### 4. Уборка `failed`

В почасовой уборке (`purge_done`) удалять также `failed`-строки старше 30 дней, у которых `fatal = TRUE`
**или** есть более новая строка с тем же `dedup_key`. Неоживляемые «последние» нефатальные строки не удалять
(они видны в «Настройки → Фоновые задачи»).

## Тесты (обязательные)

`db/tests/jobs.rs`:

- `revive_failed_requeues_after_delay` (и не раньше паузы; пауза растёт с `revivals`).
- `revive_skips_fatal`, `revive_skips_other_kinds`.
- `revive_skips_when_active_duplicate_exists`, `revive_takes_only_latest_of_same_key`.
- `fail_sets_fatal_only_on_final_failure`.
- `manual_retry_clears_fatal_and_revivals`.
- `purge_removes_old_fatal_and_superseded_failed`.

`worker/tests/runner.rs`:

- `exhausted_import_is_revived_and_completes`: обработчик `import_artist`-подобной задачи падает `max_attempts` раз,
  затем начинает отвечать успехом → после паузы оживления задача `done`, `on_retry` вызван с причиной `revived`.
- `fatal_job_is_never_revived`.

`api/tests/jobs.rs`: поле `fatal` в ответе.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov`, `just docs-check`, `just client-test` (типы API) зелёные.
- `docs/operations.md`: абзац «что происходит с упавшими задачами».

## Не входит

- Оживление `discover_album`/`verify_torrent`/`process_cue` (их повторяет `RetryMissing`).
- Отдельный интерфейс для оживлённых задач.
