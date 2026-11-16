# B14 — Проверка инвариантов и приёмочный сценарий «всё доводится до конца»

**Приоритет:** P1 · **Область:** `backend/crates/db`, `backend/crates/api`, `backend/crates/worker`, `client/tests/stack`, `scripts/load.sh` · **Зависит от:** B01–B06, B08, B09, B11–B13 (B07 и B10 желательны)

## Зачем

Задачи B01–B13 закрывают найденные дыры по одной. Эта задача даёт **доказательство**, что дыр не осталось:
формулирует «ничего не застряло» как набор проверяемых запросов к БД, показывает результат оператору и прогоняет
конвейер под отказами до состояния, в котором все инварианты выполнены. Если после B01–B13 сценарий не сходится —
это новая находка: исправить в рамках этой задачи, если исправление локальное, иначе записать в Журнал
`docs/review/README.md` отдельной задачей.

## Инварианты

Каждый — запрос, возвращающий «нарушителей». `grace` — время, которое состояние может длиться законно.

| # | Инвариант | Кто чинит |
|---|---|---|
| I1 | Трек библиотеки в `adding` дольше `grace` ⇒ у его альбома есть активная (`queued`/`running`) задача `discover_album`, `discover_artist` его артиста, `verify_torrent` или `process_cue` | `finalize_stuck_albums` + B03 |
| I2 | Связь `album_torrents.verified = FALSE` ⇒ есть активная `verify_torrent` этой пары либо активный поиск альбома/артиста | B03 |
| I3 | `cue_candidates.processed = FALSE` ⇒ есть активная `process_cue` | B03, B12 |
| I4 | Альбом с треком библиотеки `not_found` и без `adding` ⇒ `album_search_state.next_retry_at IS NOT NULL` либо есть активный поиск (при включённом `search.auto_retry`) | B02 |
| I5 | Задача `failed` с `fatal = FALSE` вида `import_artist`/`discover_artist` ⇒ она последняя по своему ключу и ждёт оживления не дольше суток | B05 |
| I6 | Задача `running` ⇒ `heartbeat_at` свежее `stale_after` | `requeue_stale` |
| I7 | Задача `queued` с `run_after < now() - grace` ⇒ для её вида есть обработчик (иначе её никто не возьмёт) | — (только отчёт) |
| I8 | Закрепление `failed` ⇒ `next_retry_at IS NOT NULL` либо `error` из списка окончательных (`dead`, постоянные ошибки) | B04 |
| I9 | Закрепление `downloading` ⇒ есть строка `downloads` его primary-файла | B04 |
| I10 | Закрепление `waiting_source` ⇒ трек `adding`/`not_found` (у `found`/`ready` оно должно стать `queued`) | `DownloadManager::tick` |
| I11 | Загрузка `completed_at IS NOT NULL` ⇒ primary-треки файла не в `found` | B08 |
| I12 | Артист библиотеки без альбомов старше `grace` ⇒ есть задача `import_artist` (активная или ожидающая оживления) | B11 |

## Текущее состояние (прочитай перед началом)

- `backend/crates/db/src/repo/` — `jobs.rs`, `acquisition.rs`, `pins.rs`, `tracks.rs`, `album_torrents.rs`, `cue_candidates.rs`.
- `backend/crates/api/src/routes.rs` (`health`), `api/src/jobs.rs`, `api/src/fakes.rs` (фейки внешних сервисов,
  `NIMBUS_FAKE_FAILURE_RATE`), `api/tests/chaos.rs`, `api/tests/common/rig.rs`.
- `scripts/load.sh`, `docker-compose.load.yml`, `client/tests/stack/resilience.spec.ts`, `stack-util.ts`;
  запись шага 51 в Журнале `ROADMAP.md` (сценарии (а)–(д)).
- `docs/DEVELOPMENT.md` §8.

## Что сделать

1. **Модуль инвариантов.** `backend/crates/db/src/repo/invariants.rs`: по функции на инвариант
   (`i1_adding_without_job(db, grace) -> Vec<Violation>` …) и `check_all(db, grace) -> Report`
   (`Violation { invariant: &'static str, entity: &'static str, id: i64, detail: String }`, не больше 50 на инвариант
   + общий счётчик). Только чтение.
2. **Видимость для оператора.**
   - `maintenance_loop`: раз в 10 минут `check_all` с `grace = 30 мин`; непустой отчёт — `tracing::warn!` по
     инварианту (число и первые id). Только отчёт: чинят страховки, а отчёт показывает, что они не справились.
   - `GET /api/jobs/invariants` (под авторизацией, как остальные `/api/jobs`) → отчёт; в `GET /api/health` —
     поле `stuck: <общее число нарушений последней проверки>`. OpenAPI, `docs/api.md`, `client/openapi.json`,
     `bun run gen:api`.
   - Клиент: в «Настройки → Фоновые задачи» строка «Застрявшие состояния: N» со списком (инвариант, сущность, id),
     видна только при N > 0; тексты — через i18n (все словари). Без действий — только показ.
3. **Интеграционный хаос-тест** (`api/tests/chaos.rs`, фейки, сокращённые интервалы в `WorkerConfig`/`ManagerConfig`,
   расписания авто-повтора сдвигаются вручную `UPDATE … next_retry_at = now()`):
   `everything_converges_under_failures` — артист с ≥ 3 альбомами (обычные раздачи, одна дискография на все альбомы,
   один образ с CUE, один альбом без раздач), автозагрузка включена. Во время работы по очереди внедряются:
   ошибки и таймауты провайдера, 503 от MusicBrainz дольше лимита попыток импорта, таймаут метаданных дискографии
   на первых двух попытках, пропажа пиров у CUE-файла на время, зависание загрузки с последующим появлением пира,
   остановка и повторный запуск пула воркеров посреди задач (`shutdown` и «жёсткий» вариант — `abort` без
   `release_workers`), паникующий хук. После снятия отказов тест ждёт (`eventually`, общий дедлайн) и проверяет:
   - `check_all(grace = 0)` пуст;
   - очередь пуста (кроме периодических задач), `failed` — только `fatal`;
   - все треки альбомов с раздачами `ready`, все закрепления `done`; у альбома без раздач — `not_found(no_torrents)`
     с назначенным `next_retry_at`.
4. **Сценарий на полном стеке.** В `client/tests/stack/resilience.spec.ts` добавить сценарий (е): то же на Docker-стеке
   с `NIMBUS_FAKE_FAILURE_RATE=0.3`, `docker compose kill -s KILL nimbus` дважды во время импорта и загрузки,
   остановка БД на 20 с; критерий — `GET /api/jobs/invariants` пуст и `health.stuck == 0` в течение отведённого
   времени, очередь разобрана. Нужные для ускорения расписаний переменные окружения добавлять только под
   `test-fakes` (не в боевую сборку) и описать в `docs/DEVELOPMENT.md` §8.
5. **Документация.** `docs/operations.md`: раздел «Застрявшие состояния» — что означает каждый инвариант и что
   делать, если нарушение держится (это баг: приложить отчёт). `docs/DEVELOPMENT.md` §3: новая фоновая сущность
   с состоянием «в процессе» обязана иметь инвариант в `invariants.rs` и страховку в обслуживании.

## Тесты (обязательные)

- `db/tests/invariants.rs`: на каждый инвариант — пара тестов «нарушение найдено» / «законное состояние не считается
  нарушением» (в т. ч. в пределах `grace`).
- `api/tests/jobs.rs`: `GET /api/jobs/invariants` — 200 с отчётом, 401 без входа; `health.stuck`.
- Хаос-тест п. 3 — стабильно зелёный 20 прогонов подряд (`cargo test … -- --test-threads=1` в цикле; результат — в Журнал).
- Клиент: unit-тест строки «Застрявшие состояния» (скрыта при 0, список при N > 0); экран добавлен в
  `client/tests/audit/screens.ts`.

## Критерии приёмки

- `just check`, `just test`, `just cov`, `just docs-check` зелёные.
- `just resilience` зелёный со сценарием (е); время схождения и число оживлений/самовосстановлений из логов — в Журнал
  `docs/review/README.md`.
- В Журнале перечислено всё, что сценарий выявил сверх B01–B13 (или «ничего»).

## Не входит

- Автоматическое исправление нарушений из отчёта: каждое нарушение — дыра в конкретной страховке, чинить нужно её.
- Проверка на живых MusicBrainz, индексерах и торрент-сети (ручная, `docs/device-checklist.md` и backlog).
