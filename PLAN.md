# Nimbus — план разработки

Веб-плеер «как Spotify/Apple Music», где метаданные берутся из **MusicBrainz**, а музыка — потоково из **торрентов** (RuTracker, The Pirate Bay, любые трекеры через Torznab).

- **Фронтенд:** форк [nextjs/next-beats](https://github.com/nextjs/next-beats) (Next.js 16, App Router, React 19, Tailwind v4) → `web/`
- **Бэкенд:** Rust (axum + sqlx + librqbit) → `backend/`
- **БД:** PostgreSQL
- **Протокол:** REST (`/api/*`) + WebSocket (`/api/ws`) для событий; аудио — HTTP с поддержкой `Range` (`/api/tracks/{id}/stream`).

---

## Как работать с этим планом («выполни следующий шаг плана»)

Каждый шаг описан в отдельном файле `docs/plan/NN-*.md` и рассчитан на выполнение **от начала до конца за одну сессию** без дополнительных вопросов.

Протокол для агента:

1. Открой этот файл, найди в таблице «Статус шагов» **первый** шаг со статусом `[ ]`, у которого все зависимости имеют статус `[x]`.
   - Если есть шаг со статусом `[~]` (начат, не закончен) — сначала продолжи его, прочитав раздел «Журнал».
2. Прочитай целиком: раздел «Соглашения» ниже, файл шага, и последние записи «Журнала».
3. Поставь шагу статус `[~]`.
4. Выполни все пункты раздела «Что сделать». Код-скелеты в файлах шагов — ориентир, а не догма: если реальный API библиотеки отличается (проверь на docs.rs / в исходниках), адаптируй, сохранив контракт (эндпоинты, схемы, имена событий).
5. Прогони **все** команды из раздела «Критерии приёмки». Шаг не закрыт, пока они не проходят.
6. Поставь шагу статус `[x]`, добавь запись в «Журнал» (дата, что сделано, отклонения от плана, что важно знать следующему шагу).
7. Сделай коммит: `step NN: <краткое описание>` (все изменения шага одним или несколькими коммитами). Не пушь, если пользователь не просил.
8. Остановись и кратко отчитайся пользователю. **Не начинай следующий шаг**, если об этом не просили.

Если шаг заблокирован (нет сети до внешнего сервиса, невозможно установить зависимость и т.п.):
- сделай всё, что возможно (моки, фикстуры, `#[ignore]`-тесты на живой сервис);
- оставь статус `[~]`, запиши в Журнал строку `БЛОК: <причина и что нужно от человека>`;
- сообщи пользователю.

Если в процессе шага пришлось изменить контракт, на который опираются будущие шаги (схема БД, DTO, имя события), — обнови соответствующие будущие файлы `docs/plan/*.md` и отметь это в Журнале.

---

## Статус шагов

Легенда: `[ ]` не начат · `[~]` в работе · `[x]` готов

| # | Статус | Шаг | Зависит от |
|---|---|---|---|
| 01 | [x] | [Монорепо и инфраструктура](docs/plan/01-monorepo-infra.md) | — |
| 02 | [x] | [Импорт next-beats и инвентаризация](docs/plan/02-import-next-beats.md) | 01 |
| 03 | [x] | [Каркас Rust-бэкенда](docs/plan/03-backend-skeleton.md) | 01 |
| 04 | [x] | [Схема БД, доменные модели, репозитории](docs/plan/04-db-schema.md) | 03 |
| 05 | [ ] | [Очередь задач, шина событий, WebSocket](docs/plan/05-jobs-events-ws.md) | 04 |
| 06 | [ ] | [Клиент MusicBrainz](docs/plan/06-musicbrainz-client.md) | 04 |
| 07 | [ ] | [API поиска + OpenAPI](docs/plan/07-search-api-openapi.md) | 06 |
| 08 | [ ] | [Фронтенд: отвязка от Prisma и синтеза, API-клиент](docs/plan/08-web-data-layer.md) | 02, 07 |
| 09 | [ ] | [Фронтенд: поиск](docs/plan/09-web-search-ui.md) | 08 |
| 10 | [ ] | [Бэкенд: добавление в библиотеку и API библиотеки](docs/plan/10-library-backend.md) | 05, 07 |
| 11 | [ ] | [Фронтенд: библиотека, статусы, live-события](docs/plan/11-web-library-ui.md) | 09, 10 |
| 12 | [ ] | [Провайдеры торрентов: trait, TPB, Torznab](docs/plan/12-providers-tpb-torznab.md) | 04 |
| 13 | [ ] | [Провайдер RuTracker](docs/plan/13-provider-rutracker.md) | 12 |
| 14 | [ ] | [Задача поиска раздач (discover)](docs/plan/14-discover-job.md) | 10, 12 |
| 15 | [ ] | [Торрент-движок: обёртка над librqbit](docs/plan/15-torrent-engine.md) | 03 |
| 16 | [ ] | [Matcher: сопоставление файлов с треками](docs/plan/16-matcher.md) | 03 |
| 17 | [ ] | [Задача верификации раздачи (verify)](docs/plan/17-verify-job.md) | 14, 15, 16 |
| 18 | [ ] | [Стриминг с Range и статус ready](docs/plan/18-streaming.md) | 17 |
| 19 | [ ] | [Фронтенд: аудиоплеер и очередь](docs/plan/19-web-player.md) | 11, 18 |
| 20 | [ ] | [Источники: ручной выбор, свой magnet, retry](docs/plan/20-sources-manual.md) | 18, 19 |
| 21 | [ ] | [CUE-образы и перекодирование ffmpeg](docs/plan/21-cue-transcode.md) | 18 |
| 22 | [ ] | [Настройки, кэш, prefetch, раздача](docs/plan/22-settings-cache-prefetch.md) | 20, 21 |
| 23 | [ ] | [Авторизация, e2e, полный docker-compose, README](docs/plan/23-hardening-e2e.md) | 22 |
| 24 | [ ] | [(Опц.) Локальное зеркало MusicBrainz](docs/plan/24-optional-mb-mirror.md) | 23 |

MVP («нашёл → добавил → играет») = шаги 01–19.

---

## Архитектура

```
Браузер (Next.js) ──REST──► Rust API (axum) ──► PostgreSQL
   │   ▲                      │   │
   │   └──── WebSocket ───────┘   ├──► MusicBrainz API / Cover Art Archive
   │                              ├──► Провайдеры: TPB (apibay), RuTracker, Torznab
   └── <audio src=/stream> ───────┴──► librqbit (торрент-движок) ──► диск (кэш)
```

### Жизненный цикл трека

```
 добавлен ──► [adding] ──(файл сопоставлен)──► [found] ──(файл полностью скачан)──► [ready]
                 │
                 └──(кандидаты исчерпаны)──► [not_found] ──(retry / свой magnet)──► [adding]
```

- `adding` — идёт поиск раздач / верификация (детальный прогресс — WS-событие `job.progress`).
- `found` — в какой-то раздаче найден файл, трек можно стримить.
- `not_found` — в `status_reason` причина: `no_torrents`, `dead_torrents`, `no_match`.
- `ready` — файл целиком лежит в локальном кэше.

### Конвейер

1. **Поиск** — `/api/search` → MusicBrainz (лимит 1 req/s, кэш).
2. **Добавление** — `POST /api/library` → сохраняем артиста/альбом/треки (статус `adding`) → задача `discover_album` / `discover_artist`.
3. **Discover** — провайдеры ищут раздачи → ранжирование → `torrents` + `album_torrents` → задачи `verify_torrent`.
4. **Verify** — librqbit получает список файлов по magnet (без скачивания) → `torrent_files` → matcher → `track_sources` → статусы `found` / `not_found`.
5. **Play** — `GET /api/tracks/{id}/stream` → librqbit качает только этот файл, куски в приоритете от текущей позиции (sequential) → `206 Partial Content`. По завершении — `ready`.

---

## Соглашения (обязательны для всех шагов)

### Структура репозитория

```
nimbus/
  PLAN.md               ← этот файл
  CLAUDE.md             ← инструкции для агента
  docs/plan/NN-*.md     ← шаги
  docs/web-inventory.md ← (шаг 02) карта компонентов next-beats
  backend/              ← Cargo workspace
    crates/{api,core,db,musicbrainz,trackers,matcher,torrent,worker}
    migrations/
  web/                  ← Next.js (форк next-beats)
  docker-compose.yml
  .env.example
  justfile
```

### Порты и переменные окружения

| Переменная | Значение по умолчанию | Где |
|---|---|---|
| `DATABASE_URL` | `postgres://nimbus:nimbus@localhost:5432/nimbus` | backend |
| `NIMBUS_BIND` | `0.0.0.0:8080` | backend |
| `NIMBUS_DATA_DIR` | `./data` (торренты, кэш, сессия librqbit) | backend |
| `NIMBUS_MB_USER_AGENT` | `Nimbus/0.1 ( https://github.com/your/nimbus )` | backend |
| `NIMBUS_CORS_ORIGIN` | `http://localhost:3000` | backend |
| `NIMBUS_TORZNAB_URL`, `NIMBUS_TORZNAB_API_KEY` | пусто (провайдер выключен) | backend |
| `NIMBUS_RUTRACKER_USERNAME`, `NIMBUS_RUTRACKER_PASSWORD`, `NIMBUS_RUTRACKER_COOKIE`, `NIMBUS_RUTRACKER_PROXY` | пусто | backend |
| `NIMBUS_TPB_ENABLED` | `true` | backend |
| `NIMBUS_CACHE_LIMIT_GB` | `50` | backend |
| `NIMBUS_SEEDING` | `false` | backend |
| `NIMBUS_API_TOKEN` | пусто (авторизация выключена; шаг 23) | backend |
| `BACKEND_URL` | `http://localhost:8080` | web (сервер) |
| `NEXT_PUBLIC_BACKEND_URL` | `http://localhost:8080` | web (браузер: stream, ws, клиентские fetch) |

Web — порт `3000`, backend — `8080`, Postgres — `5432`.

### Бэкенд

- Rust stable, edition 2021. `cargo fmt`, `cargo clippy --all-targets -- -D warnings` должны проходить.
- Ошибки: `thiserror` в библиотечных крейтах, `anyhow` только в бинарнике/воркерах. В API — единый `ApiError` → JSON `{ "error": { "code": "...", "message": "..." } }`.
- Логи: `tracing`. Никаких `println!`.
- SQL — через `sqlx` (`query!`/`query_as!` по возможности; для этого нужен `DATABASE_URL` или `cargo sqlx prepare` → `.sqlx/` коммитится).
- Все внешние HTTP-сервисы (MusicBrainz, трекеры) в тестах — через `wiremock` и фикстуры в `crates/<crate>/tests/fixtures/`. Тесты против живых сервисов — с `#[ignore]` и запускаются вручную.
- JSON — `snake_case`. Идентификаторы сущностей в API — внутренние `i64` (`id`), MBID — отдельными полями (`mbid`).
- Время — `TIMESTAMPTZ` / `chrono::DateTime<Utc>`.

### Фронтенд

- Пакетный менеджер — тот, что в next-beats (`pnpm`).
- Сохраняем стиль next-beats: Tailwind v4, `lucide-react`, Server Components + Server Functions, `useOptimistic`/`useTransition`, `'use cache'` + `cacheTag` + `updateTag`.
- Типы API — генерируются из OpenAPI бэкенда в `web/lib/api/schema.d.ts` (`pnpm gen:api`), руками не правятся.
- `pnpm lint`, `pnpm typecheck` (или `tsc --noEmit`), `pnpm build` должны проходить.

### Git

- Ветка по умолчанию — `main`. Коммиты: `step NN: ...`. Секреты (`.env`) не коммитятся.

---

## Журнал

<!-- Новые записи добавлять сверху. Формат:
### YYYY-MM-DD — шаг NN
- Сделано: ...
- Отклонения: ...
- Важно для следующих шагов: ...
-->

### 2026-11-11 — шаг 04
- Сделано: миграция `0002_schema.sql` (artists, albums, tracks, torrents, torrent_files, album_torrents, track_sources, downloads, jobs, mb_cache — ровно по плану); `core::model` (enum'ы `TrackStatus/NotFoundReason/TorrentKind/MetaStatus/TorrentSource` как TEXT с ручными `Type/Encode/Decode`, `InfoHash` с hex/base32/`from_magnet`, строки таблиц с `FromRow`, структуры `New*`, `TrackFilter`, `RankedTorrent`); репозитории `db::repo::{artists, albums, tracks, torrents, album_torrents, track_sources, downloads, mb_cache}`. Тесты: 5 unit в core, 10 интеграционных в `crates/db/tests/repos.rs`. `just db-reset && just backend` — миграции применяются (11 таблиц), health ok; `backend-check` чисто.
- Отклонения: запросы написаны через рантайм `sqlx::query_as`/`query` (не макросы `query!`) — из-за самописных text-enum'ов; поэтому `.sqlx/` и `cargo sqlx prepare` не нужны, `SQLX_OFFLINE=true cargo build` проходит. `sqlx` подключён в `core` (для `FromRow`/`Type`), `core` от `db` не зависит. Тестовый макрос: `#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]`.
- Важно для следующих шагов: сигнатуры репозиториев — функции принимают `impl PgExecutor<'_>` (пул/транзакция), кроме `torrents::replace_files` и `track_sources::set_primary`, которым нужен `&PgPool` (внутри своя транзакция). `tracks.status_reason` в строке — `Option<String>`, при записи — `Option<NotFoundReason>`. `Torrent.info_hash` — `String` (в `NewTorrent` — `InfoHash`). `set_meta_status` увеличивает `meta_attempts` только при переходе в `fetching`. `tracks::upsert_by_mbid_track` конфликтует только по `mbid_track` (для треков без него — вставка новой строки, возможен конфликт `(album_id, disc_no, position)`). `list_*_in_library` — курсор по `id DESC`. Таблица `jobs` создана, репозиторий очереди — шаг 05.

### 2026-11-11 — шаг 03
- Сделано: Rust-workspace `backend/` (крейты core, db, musicbrainz, trackers, matcher, torrent, worker, api; пакеты называются `nimbus-<имя>`, бинарник `nimbus` в `nimbus-api`), `Config::from_env` (ручной разбор, пустая строка = None), `db::connect/migrate/MIGRATOR` (`migrations/0001_init.sql` = `SELECT 1;`), `AppState`, роутер `/api` с TraceLayer и CORS, `GET /api/health`, `ApiError`, graceful shutdown, Dockerfile, рецепты `justfile` (backend, backend-test, backend-check, test, check). Тесты: 4 unit (конфиг) + 2 интеграционных (`#[sqlx::test]`: health, CORS). `cargo fmt`/`clippy -D warnings` чисто, `docker build backend` собирается, `curl /api/health` → `{"db":true,"status":"ok","version":"0.1.0"}`.
- Отклонения: установлены Rust (rustup, stable 1.99) и `just` 1.59 (`cargo install`) — в окружении их не было. Значение `NIMBUS_MB_USER_AGENT` в `.env.example` теперь в кавычках (иначе `just`/dotenv не парсят файл). Локальный `.env` использует `NIMBUS_BIND=0.0.0.0:8081` (8080 занят чужим контейнером) и порт БД 5433; в `.env.example` дефолты прежние. Тесты на этой машине: `DATABASE_URL` берётся из `.env` через `just test`.
- Важно для следующих шагов: `cargo` нужно подключать через `. ~/.cargo/env` (новая оболочка). `.env` нельзя `source`-ить — только через `just`/dotenvy. `#[sqlx::test(migrator = "nimbus_db::MIGRATOR")]` — шаблон для интеграционных тестов с БД. Шаг 04 заменит/дополнит `migrations/0001_init.sql`. Крейты musicbrainz/trackers/matcher/torrent/worker пока пустые (зависимости добавлять по мере надобности).

### 2026-11-11 — шаг 02
- Сделано: исходники next-beats (без `.github/`) в `web/`, LICENSE сохранён, в `web/README.md` добавлена строка о форке; `pnpm install`, `db push` + seed во временной БД `nextbeats_tmp`, `pnpm build`, `pnpm lint`, `tsc --noEmit` — проходят; dev: `/login` 200, остальные страницы 200 с cookie `beats-user=e2e`; `docs/web-inventory.md`; в `justfile` рецепты `web`, `web-build`, `web-check`.
- Отклонения: скриншоты не снимались (необязательно). Для локального Postgres без TLS в `DATABASE_URL` нужен `?sslmode=disable` (иначе `TlsConnectionError`) — `web/.env.local` (не коммитится) использует порт 5433.
- Важно для следующих шагов: порт 8080 на этой машине занят чужим контейнером (`alfa-equip-backend`) — для шага 03 при локальном запуске задать другой `NIMBUS_BIND` (и `BACKEND_URL`/`NEXT_PUBLIC_BACKEND_URL`). `next dev` сам создаёт `web/AGENTS.md`/`web/CLAUDE.md` — закоммичены. Next.js — canary, перед правками читать `web/node_modules/next/dist/docs/`. Подробности — `docs/web-inventory.md`.

### 2026-11-11 — шаг 01
- Сделано: `git init -b main`, `.gitignore`, `docker-compose.yml` (только db), `.env.example`, `justfile` (db-up/db-down/db-reset/psql + заглушки backend/web/test/check), `README.md`, каталоги `backend/`, `web/` (.gitkeep), `data/`.
- Отклонения: порт 5432 на машине занят Postgres другого проекта (`alfa-equip`), поэтому локальный `.env` использует `POSTGRES_PORT=5433` и `DATABASE_URL=...:5433/...`. В `.env.example` дефолты остались 5432. Проверено через psql: `select 1` → 1 на порту 5433. `just`, `cargo`, `pnpm` в окружении не установлены — `justfile` не прогонялся, рецепты `db-up` проверены вручную эквивалентными командами docker compose.
- Важно для следующих шагов: на этой машине `DATABASE_URL` из `.env` указывает на порт 5433; `just`/Rust/pnpm нужно установить до шагов 02/03. Docker-команды с этим портом: `docker compose --env-file .env ...` (compose сам читает `.env` из корня).
