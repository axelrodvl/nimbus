# B01 — Дискография объявляется мёртвой после одного таймаута метаданных

**Приоритет:** P1 · **Область:** `backend/crates/worker`, `backend/crates/db` · **Зависит от:** —

## Проблема

Счётчик `torrents.meta_attempts` — один на раздачу, а задач `verify_torrent` у раздачи столько, сколько
альбомов к ней привязано (ключ дедупликации `verify_torrent:{torrent}:{album}`). Дискография артиста
привязывается ко всем его альбомам, `verify_workers` по умолчанию 16 — задачи идут параллельно.

`load_files` (`worker/src/verify.rs`) каждая делает `set_meta_status(Fetching)`, а это `meta_attempts + 1`
(`db/src/repo/torrents.rs`, `set_meta_status`). Четыре параллельные задачи получают значения 1, 2, 3, 4;
та, что увидела 4, при таймауте не проходит условие `t.meta_attempts < MAX_META_ATTEMPTS` и сразу ставит
`MetaStatus::Dead`. Итог: раздача с ≥ 4 альбомами становится «мёртвой» после **одного** 30-секундного таймаута
вместо расписания 60 с → 5 мин → 30 мин. Остальные задачи при повторе видят `Dead` и помечают связь проверенной.
Раздача вернётся только через авто-повтор альбома (`reset_dead`, не раньше чем через 6 часов).

Вторая гонка там же: задача A получила метаданные (`Ok`), параллельная B по таймауту пишет `Timeout` поверх `Ok`.

## Текущее состояние (прочитай перед началом)

- `backend/crates/worker/src/verify.rs` — `load_files`, `RETRY_SCHEDULE`, `MAX_META_ATTEMPTS`, `retry_delay`.
- `backend/crates/db/src/repo/torrents.rs` — `set_meta_status`.
- `backend/crates/worker/src/runner.rs` — `JobCtx` (сюда добавится общее состояние).
- Тесты: `backend/crates/worker/tests/verify.rs` (фейковый `MetadataFetcher`).

## Что сделать

1. **Одна попытка получения метаданных на раздачу одновременно.** В `JobCtx` добавить
   `meta_locks: Arc<KeyedLocks>` — карта `torrent_id → Arc<tokio::sync::Mutex<()>>` под `std::sync::Mutex`
   (глобальная блокировка только на доступ к карте, не через `.await`; запись удаляется, когда на неё больше
   никто не ссылается). `JobCtx::new` создаёт пустую; `Clone` разделяет её между воркерами.
2. В `load_files` сетевую ветку (от `set_meta_status(Fetching)` до конца) выполнять под блокировкой раздачи.
   Ожидание блокировки — через `ctx.run(...)` (отменяемо). **После** получения блокировки перечитать раздачу
   из БД и повторить проверки начала функции:
   - `Ok` и файлы есть → вернуть файлы (сеть не нужна);
   - `Dead` / `Error` → пустой список;
   - `meta_attempts` вырос по сравнению со значением до ожидания и статус `Timeout` → другая задача только что
     потратила попытку: вернуть `JobError::Retry { after: retry_delay(meta_attempts) }` **без** нового запроса;
   - иначе — обычный путь (`Fetching`, запрос).
3. `set_meta_status` не должен понижать `ok`: в SQL добавить условие — переход в `timeout`/`dead`/`error`/`fetching`
   не применяется, если текущий статус `ok` и у раздачи есть файлы (`EXISTS (SELECT 1 FROM torrent_files …)`).
   Функция по-прежнему возвращает актуальную строку.
4. Комментарии у `MAX_META_ATTEMPTS` и `meta_attempts` в модели: «одна попытка = один сетевой запрос, сколько бы
   задач его ни ждало».

## Тесты (обязательные)

`worker/tests/verify.rs`:

- `discography_timeout_counts_one_attempt`: одна раздача привязана к 6 альбомам, фейковый fetcher всегда отдаёт
  `MetadataTimeout` и считает вызовы; 6 задач `verify_torrent` запускаются параллельно → fetcher вызван 1 раз,
  `meta_attempts == 1`, статус `timeout`, все 6 задач вернули `Retry`. (Без исправления тест падает: `dead`.)
- `discography_metadata_fetched_once`: fetcher с задержкой отдаёт метаданные; 6 параллельных задач → 1 вызов,
  у всех 6 альбомов появились `track_sources`.
- `timeout_does_not_downgrade_ok` (`db/tests/repos.rs`): `set_meta_status(Timeout)` для раздачи с `ok` и файлами
  оставляет `ok`.
- Существующий сценарий «4 таймаута подряд → `dead`» для одной задачи остаётся зелёным.

## Критерии приёмки

- `just check`, `just backend-test` зелёные; `just cov` не ниже порога.
- В блокировке нет удержания глобального мьютекса через `.await`.

## Не входит

- Изменение расписания `RETRY_SCHEDULE` и логики `reset_dead`.
