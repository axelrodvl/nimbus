# B10 — Штатная остановка может не успевать до SIGKILL

**Приоритет:** P2 · **Область:** `backend/crates/api` (`main.rs`), `docker-compose*.yml` · **Зависит от:** —

## Проблема (гипотеза — сначала подтвердить)

Порядок остановки в `main.rs`: `axum::serve(...).with_graceful_shutdown(...)` → `shutdown.cancel()` → ожидание
`watcher`, `poker`, `manager` → `workers.shutdown()` (до `shutdown_timeout` = 10 с) → `engine.shutdown()` (≥ 1 с).

Два узких места:

1. `with_graceful_shutdown` ждёт завершения **всех открытых HTTP-соединений** без ограничения по времени.
   Длинный ответ (`/api/tracks/{id}/stream` — плеер читает файл по мере буферизации; загрузка трека на устройство)
   может держать его минутами. Пока он ждёт, воркеры не получают отмену и продолжают брать задачи.
2. В `docker-compose.yml` нет `stop_grace_period` — Docker шлёт SIGKILL через 10 секунд после SIGTERM. Сумма
   «дренаж HTTP + 10 с воркеров + 1 с движка» в 10 секунд не укладывается.

Следствия нештатной остановки: задачи возвращаются через `recover_orphans`, а не `release_workers` (после B07 это
ещё и счётчик падений), сессия торрент-движка и DHT не сохраняются штатно, загрузки возобновляются с последней
точки сохранения librqbit.

## Текущее состояние (прочитай перед началом)

- `backend/crates/api/src/main.rs` — конец `main`, `shutdown_signal`.
- `backend/crates/api/src/ws.rs`, `stream.rs` — обработчики долгих ответов.
- `backend/crates/worker/src/runner.rs` — `WorkerPool::shutdown`.
- `docker-compose.yml`, `docker-compose.e2e.yml`, `docker-compose.load.yml`, корневые `start.sh`/`stop.sh`, `deploy/`.
- `client/tests/stack/` и `just resilience` — сценарий рестарта.

## Что сделать

1. **Подтвердить.** Поднять стек (`./scripts/build.sh && ./scripts/start.sh`), открыть долгий запрос
   (`curl --limit-rate 1k http://localhost:8000/api/tracks/<id>/stream -o /dev/null` для трека `ready`, с cookie
   авторизации), выполнить `docker compose stop nimbus` и посмотреть в логах, есть ли строка `shutdown complete`
   и сколько заняла остановка. Результат — в Журнал `docs/review/README.md`. Если строка есть и остановка < 10 с —
   выполнить только п. 4 и закрыть задачу.
2. **Параллельная остановка с дедлайном.** По сигналу сразу отменять общий токен (воркеры перестают брать задачи,
   обработчики получают `ctx.cancel`), а дренаж HTTP ограничить: сервер запускается как задача, после сигнала
   ждём её не дольше `HTTP_DRAIN_TIMEOUT` (5 с), затем прерываем (`abort`). Для этого `shutdown_signal()` должен
   отменять `shutdown`-токен, а `with_graceful_shutdown` — ждать этот токен; `workers.shutdown()` запускать
   одновременно с дренажом (`tokio::join!`), `engine.shutdown()` — последним.
3. **Долгие ответы сами завершаются по остановке.** Тело стрима и цикл WebSocket получают токен остановки из
   `AppState` (добавить `shutdown: CancellationToken`) и закрываются по нему: WebSocket — кадром `Close`
   (клиент переподключится сам), стрим — обрывом тела.
4. **Запас времени у контейнера.** В `docker-compose.yml` (и в compose-файле из `deploy/`, если сервис описан там)
   сервису `nimbus` добавить `stop_grace_period: 30s`; в `docs/operations.md` — строка о том, что остановка занимает
   до ≈ 15 секунд и почему её нельзя сокращать.

## Тесты (обязательные)

- `api/tests/ws.rs`: `websocket_closes_on_shutdown` — отмена токена → клиент получает `Close`.
- `api/tests/stream.rs`: `stream_body_ends_on_shutdown` — тело потока завершается после отмены, не дожидаясь клиента.
- Если логика остановки вынесена из `main.rs` в функцию (`run_until_shutdown(...)`) — интеграционный тест:
  открытое «вечное» соединение не мешает функции вернуться за `HTTP_DRAIN_TIMEOUT + ε`.
- Ручная проверка п. 1 повторно: `shutdown complete` в логах при открытом стриме; время — в Журнал.

## Критерии приёмки

- `just check`, `just backend-test` зелёные; `just e2e` зелёный (остановка стека в конце сценария не висит).
- `main.rs` остаётся исключённым из покрытия; новая логика — в тестируемой функции.

## Не входит

- Ускорение `Session::stop` librqbit (backlog B11).
