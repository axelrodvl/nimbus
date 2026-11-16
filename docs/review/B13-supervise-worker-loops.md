# B13 — Циклы воркеров и обслуживания не переживают панику

**Приоритет:** P1 · **Область:** `backend/crates/worker` (`runner.rs`) · **Зависит от:** —

## Проблема

`WorkerPool::spawn` запускает в `JoinSet` три вида задач: `listen_loop`, `maintenance_loop` и по `worker_loop`
на каждый слот. Паника **обработчика** изолирована (`process` выполняет `handle` в отдельном `tokio::spawn`).
Но всё остальное выполняется прямо в теле цикла:

- `on_retry` / `on_exhausted` (хуки обработчиков — тот же прикладной код: `finalize_album`, работа с БД);
- `maintenance_loop`: `finalize_stuck_albums`, вызовы `exhausted(...)`, уборка, постановка `RetryMissing`/`EvictCache`;
- сам `process` до и после вызова обработчика.

Паника в любом из этих мест завершает задачу tokio. `JoinSet` никто не опрашивает до `shutdown`, поэтому:

- умерший `worker_loop` — слот потерян до рестарта процесса; если так умерли все воркеры вида (например, единственный
  воркер `retry_missing` или `evict_cache`), задачи этого вида больше не выполняются;
- умерший `maintenance_loop` — нет возврата зависших задач, авто-повтора поиска, вытеснения кэша, страховок
  (и всех новых из B02, B03, B05, B11);
- умерший `listen_loop` — только задержка до `poll_interval`, но тоже навсегда.

Процесс при этом «здоров»: `/api/health` отвечает, в логах одна строка паники. `Watcher` и `DownloadManager`
(`api/src/stream.rs`, `download_manager.rs`) уже работают под супервизором с `catch_unwind` — здесь нужен тот же приём.

## Текущее состояние (прочитай перед началом)

- `backend/crates/worker/src/runner.rs` — `WorkerPool::spawn`, `listen_loop`, `maintenance_loop`, `worker_loop`,
  `process`, `run_exhausted`, `AbortOnDrop`.
- `backend/crates/api/src/download_manager.rs` — `spawn_download_manager_with` (образец супервизора).
- `backend/crates/api/src/routes.rs` — `health`.
- Тесты: `backend/crates/worker/tests/runner.rs`.

## Что сделать

1. **Супервизор циклов.** Вспомогательная функция
   `supervise(name, token, restart_pause, make: impl Fn() -> Future)`: выполняет цикл под
   `AssertUnwindSafe(...).catch_unwind()`; при панике — `tracing::error!(task = name, panic = …)`, счётчик
   перезапусков, пауза `restart_pause` (отменяемая токеном), новый запуск. Нормальное завершение (по отмене) —
   выход. Обернуть ею `listen_loop`, `maintenance_loop` и каждый `worker_loop`. Пауза — поле `WorkerConfig`
   (`restart_pause`, по умолчанию 1 с).
2. **Задача умершего воркера.** Если паника случилась внутри `process` после `claim`, строка осталась `running`
   за этим `worker_id`. После перезапуска цикла тот же `worker_id` начинает с возврата своих задач:
   `jobs::release_workers(&[worker_id])` перед первым `claim` (попытка возвращается — виноват не обработчик).
   Чтобы паникующий хук не зациклил одну и ту же задачу: см. п. 3.
3. **Хуки не роняют цикл.** `on_retry` и `on_exhausted` вызывать через отдельный `tokio::spawn` (как `handle`)
   и трактовать панику как ошибку хука: для `on_exhausted` — обычные повторы `run_exhausted`, затем лог `error`.
   Итог задачи к этому моменту уже записан в БД, поэтому п. 2 для этого случая не сработает и зацикливания нет.
4. **Шаги обслуживания изолированы.** Каждый шаг `maintenance_loop` (возврат зависших, страховки, уборка,
   постановка периодических задач) — в своём `catch_unwind`: паника одного шага не отменяет остальные в этом тике.
   Вынести шаги в отдельные `async fn` — цикл станет списком вызовов.
5. **Видимость.** Счётчики перезапусков (`AtomicU64` на пул: воркеры, обслуживание, слушатель) отдать через
   `WorkerPool::stats()` и показать в `GET /api/health` (поле `workers: { restarts: … }`; OpenAPI, `docs/api.md`).
   Ненулевое значение — повод смотреть логи.

## Тесты (обязательные)

`worker/tests/runner.rs`:

- `worker_survives_panicking_on_exhausted_hook`: обработчик, у которого `on_exhausted` паникует; первая задача
  исчерпывает попытки → вторая задача того же вида всё равно выполняется тем же (единственным) воркером.
- `worker_survives_panicking_on_retry_hook`.
- `maintenance_survives_panicking_step`: шаг обслуживания паникует (внедрить через обработчик, чей `on_exhausted`
  вызывается из `requeue_stale`-ветки) → на следующем тике зависшая задача другого вида возвращена в очередь.
- `restarted_worker_releases_its_running_job`: строка `running` с `locked_by` воркера, цикл перезапущен →
  задача снова `queued`, `attempts` не выросли.
- `supervisor_stops_on_cancel`: отмена токена во время паузы перезапуска завершает задачу; `shutdown` не висит.
- `restart_counters_are_reported`.

`api/tests/health.rs`: поле `workers.restarts` в ответе.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov`, `just docs-check` зелёные.
- В `runner.rs` не осталось прикладного кода (хуки, финализация), выполняемого в теле цикла без изоляции паники.

## Не входит

- Автоматическое завершение процесса при частых перезапусках циклов (решение оператора по `health`).
