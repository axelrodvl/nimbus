# B07 — «Ядовитая» задача крутит crash-loop

**Приоритет:** P2 · **Область:** `backend/crates/db` (`jobs.rs`), `backend/crates/worker` (`runner.rs`) · **Зависит от:** B05 · **Закрывает:** `docs/backlog.md` B2

## Проблема

`recover_orphans` при старте возвращает в очередь все `running` и **возвращает потраченную попытку**
(`attempts - 1`). Это правильно для обычного рестарта, но задача, которая роняет сам процесс (abort, OOM,
переполнение стека в зависимости), после каждого рестарта берётся снова с тем же счётчиком попыток —
процесс падает бесконечно, остальная очередь стоит.

Паника обработчика сюда не относится: её ловит `tokio::spawn` в `process`.

## Текущее состояние (прочитай перед началом)

- `backend/crates/db/src/repo/jobs.rs` — `recover_orphans`, `release_workers` (штатная остановка — другой путь), `complete`.
- `backend/crates/worker/src/runner.rs` — `WorkerPool::start`, `exhausted`, `run_exhausted`.
- После B05 в `jobs` есть `fatal`, `revivals` и оживление нефатальных `failed`.

## Что сделать

1. Миграция: `ALTER TABLE jobs ADD COLUMN crashes INT NOT NULL DEFAULT 0;` — сколько раз задача была `running`
   в момент нештатного завершения процесса.
2. `recover_orphans(db, max_crashes: i32) -> sqlx::Result<OrphanOutcome { requeued: u64, failed: Vec<JobRow> }>`:
   одним `UPDATE … RETURNING *`:
   - `crashes = crashes + 1`;
   - если `crashes + 1 >= max_crashes` → `state = 'failed'`, `fatal = FALSE`,
     `last_error = 'process crashed N times while running this job'`;
   - иначе как сейчас (`queued`, попытка возвращается).
3. `release_workers`, `release`, `complete` счётчик не трогают: штатная остановка — не падение.
   Ручной повтор (`jobs::retry`) и оживление (`revive_failed`) обнуляют `crashes`.
4. `WorkerPool::start`: порог — `WorkerConfig::max_crashes` (по умолчанию 3). Для задач из `failed` вызвать
   `on_exhausted` (как делает `maintenance_loop` для `requeue_stale`): данные не должны остаться «в процессе».
   Вызывать после построения карты обработчиков, до запуска воркеров; ошибку хука логировать.
   В лог — `error!` с `job_id`, `kind`, `payload`: это единственный след причины падений.
5. Невиновные задачи, выполнявшиеся в момент падения, тоже получают `crashes + 1`. Это допустимо: порог 3,
   провал нефатальный — `import_artist`/`discover_artist` оживит B05, альбомные задачи доведёт `RetryMissing`.
   Записать это в doc-комментарий `recover_orphans`.
6. Убрать запись B2 из `docs/backlog.md`.

## Тесты (обязательные)

`db/tests/jobs.rs`:

- `recover_orphans_counts_crashes_and_fails_at_threshold`: три цикла «claim → recover_orphans(3)» → после третьего
  задача `failed`, `fatal = false`, возвращена в `failed`-списке; первые два — `queued`, `attempts` не выросли.
- `graceful_release_does_not_count_crash`: `claim → release_workers` много раз → `crashes == 0`.
- `retry_and_revive_reset_crashes`.

`worker/tests/runner.rs`:

- `start_runs_on_exhausted_for_crash_looping_job`: в БД задача `running` с `crashes = 2` → `WorkerPool::start`
  переводит её в `failed` и вызывает `on_exhausted` обработчика; остальные задачи выполняются.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov` зелёные.

## Не входит

- Сценарий с настоящим падением процесса в Docker (`just resilience`) — по желанию, отдельным пунктом Журнала.
