# Шаг 32 — Состояние приобретения альбомов, массовый и автоматический повтор поиска

**Фаза 1 · Зависит от:** 29 · **Закрывает находки:** D6, J6

## Зачем

Сейчас узнать, что альбом не нашёлся, можно только зайдя в него, а повторить поиск — только вручную и
по одному. Нужны: (1) единое вычисляемое состояние «приобретения» альбома, (2) API списка проблемных
и ещё не скачанных альбомов, (3) повтор поиска одной кнопкой для всех, (4) автоматический повтор с
растущими интервалами. Это серверная половина экрана «Загрузки» (шаг 44).

## Текущее состояние

- Статусы треков: `adding | found | not_found | ready`, причина — `status_reason` (`no_torrents`, `dead_torrents`, `no_match`, `search_failed`).
- `backend/crates/api/src/sources.rs` — `retry_album` (`POST /api/albums/{id}/retry`), `retry_track`: сбрасывают статусы и ставят `DiscoverAlbum`. **Прочитай их** — массовый повтор должен переиспользовать ту же логику (вынеси её в `nimbus-library`).
- `backend/crates/api/src/library.rs` — `AlbumDto` со `StatusCounts`; `backend/crates/db/src/repo/views.rs` — запросы для списков.
- `backend/crates/worker/src/discover.rs` — `discover_album` (знает число кандидатов и ошибки провайдеров, но нигде это не сохраняет).
- `backend/crates/worker/src/runner.rs` — `maintenance_loop` (периодические действия: `requeue_stale`, `purge_done`, `EvictCache`).
- `backend/crates/core/src/events.rs` — события; `core/src/jobs.rs` — `enum Job`.
- Настройки: `SearchSettings` в `core/src/settings.rs`.

## Что сделать

1. **Миграция `0009_acquisition.sql`:**
   ```sql
   CREATE TABLE album_search_state (
       album_id         BIGINT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
       attempts         INT NOT NULL DEFAULT 0,          -- завершённых поисков
       last_started_at  TIMESTAMPTZ,
       last_finished_at TIMESTAMPTZ,
       last_outcome     TEXT,                            -- found | partial | no_torrents | dead_torrents | no_match | search_failed
       candidates       INT NOT NULL DEFAULT 0,          -- сколько раздач дал последний поиск
       provider_errors  JSONB NOT NULL DEFAULT '[]',     -- [{source, error}]
       next_retry_at    TIMESTAMPTZ,                     -- когда авто-повтор (NULL — не планируется)
       auto_retries     INT NOT NULL DEFAULT 0           -- сколько авто-повторов уже было с последнего успеха/ручного запуска
   );
   CREATE INDEX album_search_retry_idx ON album_search_state (next_retry_at) WHERE next_retry_at IS NOT NULL;
   ```
   Репозиторий `db::repo::acquisition`.
2. **Запись состояния поиска.** `discover_album`: в начале — `last_started_at`; при завершении **поиска и
   финализации** альбома (функция `finalize` в `verify.rs`, когда больше нет непроверенных раздач и активных discover) —
   `last_finished_at`, `attempts += 1`, `last_outcome`, `candidates`, `provider_errors`.
   Исход: `found` (все треки библиотеки `found|ready`), `partial` (часть), иначе — причина `not_found`.
   Для исходов, отличных от `found`, вычислить `next_retry_at = now() + backoff(auto_retries)`, где backoff:
   6 ч, 1 д, 3 д, 7 д, далее 30 д. Для `found` — `next_retry_at = NULL`, `auto_retries = 0`.
3. **Состояние приобретения** (вычисляется, не хранится) — `enum AcquisitionState`:
   | Состояние | Условие (по трекам альбома с `in_library`) |
   |---|---|
   | `searching` | есть трек `adding` |
   | `missing` | нет `found`/`ready`, есть `not_found` |
   | `partial` | есть `not_found` и есть `found`/`ready` |
   | `available` | все `found`/`ready`, не все `ready`, нет активной загрузки |
   | `downloading` | есть активная загрузка файлов альбома (строки `downloads` без `completed_at`) |
   | `downloaded` | все `ready` |
   Приоритет при совпадении условий: `searching` > `downloading` > `partial` > `missing` > `available` > `downloaded`.
   Один SQL-запрос (CTE по `tracks`, `track_sources`, `downloads`) в `acquisition::list`.
4. **API** (`crates/api/src/acquisition.rs`, все — с `authorize`, в OpenAPI):
   - `GET /api/acquisition?state=<список через запятую>&cursor=&limit=` → `{ items: [AcquisitionItem], next_cursor }`, сортировка: сначала `searching`, затем по `last_finished_at DESC NULLS LAST`, `album_id`;
     ```
     AcquisitionItem {
       album: { id, title, year, cover_url, artist: { id, name } },
       state, tracks: { total, adding, found, not_found, ready },
       reason,                      // преобладающий status_reason у not_found
       search: { attempts, last_finished_at, last_outcome, candidates, provider_errors, next_retry_at },
       download: { bytes_done, bytes_total } | null,
       active_jobs: u32             // queued+running discover/verify/cue по альбому
     }
     ```
   - `GET /api/acquisition/summary` → `{ searching, missing, partial, available, downloading, downloaded, failed_jobs }`;
   - `POST /api/acquisition/retry` тело `{ scope: "missing" | "albums", album_ids?: [i64], reset_dead?: bool }` → `{ queued: u32 }`.
     `scope = "missing"` — все альбомы в состояниях `missing`/`partial`. `reset_dead = true` — раздачам альбома с `meta_status in (dead, timeout, error)` вернуть `pending` и `meta_attempts = 0` (их проверят заново). Ставит `DiscoverAlbum` с приоритетом `INTERACTIVE`, сбрасывает `auto_retries = 0`. Не более 5000 альбомов за вызов.
   Существующие `POST /api/albums/{id}/retry` и `/tracks/{id}/retry` — оставить, реализовать через ту же функцию.
5. **Автоповтор.** Новая задача `Job::RetryMissing` (dedup `retry_missing`): выбирает до 50 альбомов с `next_retry_at <= now()`
   в состояниях `missing`/`partial`, ставит им `DiscoverAlbum` с приоритетом `BACKGROUND`, `auto_retries += 1`, `next_retry_at = NULL` (переустановится по итогам поиска).
   `maintenance_loop` ставит `RetryMissing` раз в 15 минут, если `settings.search.auto_retry` (`bool`, по умолчанию `true`).
   Повторный поиск **не** должен заново проверять раздачи, уже проверенные для этого альбома (`album_torrents.verified`), — только новые кандидаты и сброшенные.
6. **Повтор при изменении провайдеров.** Когда `PUT /api/settings` меняет раздел `providers` так, что появился новый
   включённый провайдер (или изменились учётные данные), ответ содержит `suggest_retry_missing: true`, а всем
   `missing`/`partial` альбомам выставляется `next_retry_at = now()` (подхватит ближайший `RetryMissing`).
7. **Событие `acquisition.changed { album_id }`** — публикуется при смене вычисленного состояния альбома:
   в местах, где меняются статусы треков альбома (`set_track_status_and_publish`, `set_status_for_album`) и при записи состояния поиска.
   Не чаще одного события на альбом в 500 мс (коалесцирующий издатель в `EventBus` или локальный debounce — выбери простое и покрой тестом).
8. **Документация:** `docs/api.md`, `docs/architecture.md` (раздел «Приобретение альбомов»: состояния, авто-повтор, backoff).

## Тесты (обязательные)

`crates/db/tests/repos.rs` (или `acquisition.rs`):
- вычисление состояния для каждого варианта таблицы из п. 3, включая приоритеты; треки вне библиотеки не учитываются;
- фильтр `state`, курсорная пагинация (стабильный порядок, нет дублей/пропусков на границе страниц), `summary` совпадает с подсчётом по `list`.

`crates/worker/tests/discover.rs` / `verify.rs`:
- запись `album_search_state` по каждому исходу; `provider_errors` содержит источник и текст; backoff 6 ч → 1 д → 3 д → 7 д → 30 д;
- успешный поиск обнуляет `auto_retries` и `next_retry_at`;
- повторный поиск не ставит verify для уже проверенных раздач; с `reset_dead` — ставит.

`crates/worker/tests/retry_missing.rs`: задача берёт только просроченные `missing`/`partial`, не больше 50, ставит `BACKGROUND`; выключенный `auto_retry` → обслуживание не ставит задачу.

`crates/api/tests/acquisition.rs`:
- список/фильтры/summary; 401 без токена; невалидный `state` → 400;
- `retry` со `scope = "missing"` и с `album_ids`; несуществующие id игнорируются и не входят в `queued`; пустой результат → `queued: 0`;
- `PUT /api/settings` с новым провайдером → `suggest_retry_missing: true`, `next_retry_at` выставлен.

События: смена статуса трека → `acquisition.changed` для альбома; 20 смен за 100 мс → не более 2 событий.

## Критерии приёмки

```
just db-up && just check && just test && just cov
just openapi && just web-gen-api && just web-check
```

## Не входит в шаг

- Скачивание альбомов на сервер и состояние `downloading` от очереди закрепления (шаг 33 — он расширит `download` в `AcquisitionItem`).
- Интерфейс (шаг 44).

## Подводные камни

- «Преобладающая причина»: если причин несколько, бери по приоритету `search_failed` > `no_torrents` > `dead_torrents` > `no_match`.
- Финализация альбома может вызываться много раз (каждый verify) — запись `attempts += 1` должна происходить ровно один раз на поиск: привяжи её к переходу «был активный поиск → больше нет» (например, `last_started_at > COALESCE(last_finished_at, '-infinity')`), в той же транзакции с блокировкой строки альбома.
- `RetryMissing` и ручной повтор могут встретиться — `dedup_key` у `DiscoverAlbum` защитит от дубля; ручной должен поднять приоритет (механизм шага 26).
