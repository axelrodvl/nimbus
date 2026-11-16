# B06 — Запись итога задачи без проверки владельца

**Приоритет:** P1 · **Область:** `backend/crates/db` (`jobs.rs`), `backend/crates/worker` (`runner.rs`) · **Зависит от:** — · **Закрывает:** `docs/backlog.md` B1

## Проблема

`jobs::complete`, `fail`, `defer`, `release` обновляют строку по одному `id`. Если воркер надолго завис
(пул соединений исчерпан, диск, пауза процесса > `stale_after` = 90 с), `requeue_stale` возвращает задачу в очередь,
её берёт другой воркер. Когда первый «оживает» и дописывает итог, он:

- `complete` — помечает `done` задачу, которую в этот момент выполняет второй воркер (тот потом запишет свой итог
  поверх; при `fail` второго задача из `done` станет `queued`/`failed`);
- `fail` — возвращает в `queued` задачу, которая уже `running` у второго → третий воркер берёт её параллельно;
- `release` защищён только `state = 'running'` — вернёт попытку и снимет блокировку у чужого захвата.

Heartbeat уже проверяет владельца (`locked_by = $2`), запись итога — нет.

## Текущее состояние (прочитай перед началом)

- `backend/crates/db/src/repo/jobs.rs` — `claim`, `heartbeat`, `complete`, `fail`, `defer`, `release`.
- `backend/crates/worker/src/runner.rs` — `process`, `heartbeat_loop`.
- Тесты: `backend/crates/db/tests/jobs.rs`, `backend/crates/worker/tests/runner.rs`
  (вызовов `complete`/`fail` в тестах много — сигнатуры меняются).

## Что сделать

1. Всем четырём функциям добавить параметр `worker_id: &str` и условие
   `WHERE id = $1 AND state = 'running' AND locked_by = $worker`.
   - `complete` → `sqlx::Result<bool>` (обновлена ли строка);
   - `fail`, `defer` → `sqlx::Result<Option<JobRow>>` (`fetch_optional`);
   - `release` → `sqlx::Result<bool>`.
2. `runner::process`: при `false`/`None` — `tracing::warn!(job_id, kind, worker, "job was taken over; result dropped")`
   и выход **без** вызова `on_retry`/`on_exhausted` (итог запишет новый владелец).
3. Обработчики идемпотентны (правило `docs/DEVELOPMENT.md` §3), поэтому двойное выполнение безопасно для данных;
   менять обработчики не нужно.
4. `heartbeat_loop` при `Ok(false)` сейчас только пишет предупреждение. Добавить: отменять выполнение обработчика —
   передать в `process` `CancellationToken` задачи (дочерний от `ctx.cancel`), который heartbeat отменяет при потере
   владения; обработчик увидит отмену через `ctx.run(...)` и вернёт `JobError::Cancelled`, а `release` с проверкой
   владельца ничего не тронет.
5. Убрать запись B1 из `docs/backlog.md`.

## Тесты (обязательные)

`db/tests/jobs.rs`:

- `complete_by_lost_worker_is_ignored`: A берёт задачу; `requeue_stale(0)`; B берёт её; `complete(id, "A")` → `false`,
  строка `running` у B; `complete(id, "B")` → `true`.
- `fail_by_lost_worker_is_ignored`, `defer_by_lost_worker_is_ignored`, `release_by_lost_worker_is_ignored` — аналогично.

`worker/tests/runner.rs`:

- `taken_over_job_drops_result_and_skips_hooks`: обработчик «зависает» дольше `stale_after` (малое значение в конфиге,
  heartbeat отключён/замедлен), задача перехвачена вторым воркером → первый не вызывает `on_exhausted`/`on_retry`,
  итог задачи — тот, что записал второй.
- `lost_ownership_cancels_handler`: после потери владения `ctx.cancel` обработчика срабатывает.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov` зелёные (порог `db::repo::jobs` ≥ 95 %).

## Не входит

- Несколько процессов воркеров на одной БД (остаётся допущение «один экземпляр»).
