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
| 05 | [x] | [Очередь задач, шина событий, WebSocket](docs/plan/05-jobs-events-ws.md) | 04 |
| 06 | [x] | [Клиент MusicBrainz](docs/plan/06-musicbrainz-client.md) | 04 |
| 07 | [x] | [API поиска + OpenAPI](docs/plan/07-search-api-openapi.md) | 06 |
| 08 | [x] | [Фронтенд: отвязка от Prisma и синтеза, API-клиент](docs/plan/08-web-data-layer.md) | 02, 07 |
| 09 | [x] | [Фронтенд: поиск](docs/plan/09-web-search-ui.md) | 08 |
| 10 | [x] | [Бэкенд: добавление в библиотеку и API библиотеки](docs/plan/10-library-backend.md) | 05, 07 |
| 11 | [x] | [Фронтенд: библиотека, статусы, live-события](docs/plan/11-web-library-ui.md) | 09, 10 |
| 12 | [x] | [Провайдеры торрентов: trait, TPB, Torznab](docs/plan/12-providers-tpb-torznab.md) | 04 |
| 13 | [x] | [Провайдер RuTracker](docs/plan/13-provider-rutracker.md) | 12 |
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

### 2026-11-11 — шаг 13
- Сделано: `trackers::rutracker::RutrackerProvider` (`RutrackerOptions`): reqwest с cookie jar, браузерный UA, таймаут 20 с, опциональный прокси; декодирование ответов и кодирование запроса/формы логина в cp1251 (`encoding_rs`, `encode_cp1251`); вход через `POST login.php` (капча → `Auth("captcha required: set NIMBUS_RUTRACKER_COOKIE")`, нет `bb_session` → `Auth`), либо готовая cookie (логин пропускается); разлогин (редирект на `login.php` или нет `#logged-in-username`) → один повторный вход, затем `Auth`; для режима «только cookie» — сразу `Auth("…update NIMBUS_RUTRACKER_COOKIE")`. Поиск `tracker.php?nm=…&o=10&s=2`, разбор `scraper` (селекторы — в модуле `sel`, музыкальная регулярка — константа `MUSIC_CATEGORY_RE`), размер из `data-ts_text` либо из текста «1.2 GB». `resolve`: сначала API `api.rutracker.cc` (magnet из `RUTRACKER_TRACKERS`), при `null`/ошибке — `viewtopic.php` → `a.magnet-link` (magnet с passkey не трогается). Сеть/таймаут → `Blocked` с подсказкой про `NIMBUS_RUTRACKER_PROXY`. Лимитер 1 запрос / 2 с. `ProviderRegistry::from_config` регистрирует RuTracker при логине+пароле или cookie (`from_config` теперь возвращает `ProviderError`). Тесты: 2 unit + 13 интеграционных (wiremock; cp1251-фикстуры `rutracker_*.html`, `rutracker_api*.json`) + живой `#[ignore]` (нужны креды в env).
- Отклонения: **RuTracker из этого окружения недоступен** (`rutracker.org` → 403, `api.rutracker.cc` → «Temporarily disabled»), живой тест не запускался — провайдер проверен **только на фикстурах**, собранных вручную по описанной структуре страницы; селекторы на реальной вёрстке не сверены. Голое значение cookie без `=` трактуется как `bb_session=<значение>`. Сиды `-`/пусто/отрицательные → `None`.
- Важно для следующих шагов: при первом реальном запуске с кредами прогнать `cargo test -p nimbus-trackers -- --ignored live_rutracker` и при расхождении поправить только константы в `rutracker::sel`. `resolve` для RuTracker может пойти в viewtopic (нужна сессия) — шаг 14 должен обрабатывать `Err` у отдельного кандидата и не ронять весь поиск. Шаг 22 переносит cookie в `settings`: `RutrackerOptions.cookie` задаётся при создании провайдера, для смены на лету потребуется пересоздавать провайдер в реестре.

### 2026-11-11 — шаг 12
- Сделано: крейт `nimbus-trackers`: `TorrentProvider` (`search`, `resolve`), `SearchQuery`, `TorrentCandidate`, `ProviderError`; `build_magnet` + `PUBLIC_TRACKERS`; `TpbProvider` (apibay, строки-числа, «No results returned» → пусто, категории только 100–199, настраиваемый base URL); `TorznabProvider` (`t=music` → fallback `t=search&cat=3000`, `<torznab:attr>`, `leechers = peers - seeders`, `<error>` → `Auth`; `resolve` скачивает `.torrent` и считает info-hash — собственный разбор bencode + `sha1`); `ProviderRegistry::from_config` / `search_all` (параллельно, таймаут 20 с, сбой/таймаут одного не мешает остальным); `build_queries` (4 варианта, скобки убираются, `&`→`and` во второй). Лимитер `governor` 1 запрос / 2 с на провайдера. Тесты: 6 unit + 12 интеграционных (wiremock, фикстуры в `tests/fixtures/`, реальный ответ apibay `tpb_real.json` записан 2026-11-11) + живой `#[ignore]` — прошёл (`cargo test -p nimbus-trackers -- --ignored`).
- Отклонения: в `TorrentCandidate` добавлено `download_url: Option<String>` (ссылка на `.torrent` для `resolve`); в `SearchQuery` — `broad: bool` (запрос «только артист», для провайдеров с хорошим поиском; последний в `build_queries`); в `ProviderError` — вариант `Timeout`. Пакет называется `nimbus-trackers` (`-p nimbus-trackers`). `.torrent`-кандидаты Torznab не пропускаются — резолвятся через `resolve`.
- Важно для следующих шагов: шаг 13 регистрирует RuTracker в `ProviderRegistry::from_config` (там есть комментарий-заглушка в doc). Шаг 14: вызывать `search_all` для каждого `build_queries(..)` (запрос с `broad=true` слать осознанно), затем `resolve` для кандидатов без `info_hash` через `registry.get(source)`; дедуп по `info_hash`. Лимитер лежит внутри провайдера, поэтому `Arc`-провайдеры нужно переиспользовать, а не создавать на каждый запрос. quick-xml сопоставляет элементы по локальному имени (`torznab:attr` → `attr`).

### 2026-11-11 — шаг 11
- Сделано (web): Server Functions в `app/actions/library.ts` (`addToLibrary`, `removeFromLibrary` возвращают `{ok,…}`/`{ok:false,code,message}` с понятными текстами, `revalidateLibrary(tags)`, `loadMore*`), `lib/data/library.ts` (`'use cache'` + теги `library`/`artist:{id}`/`album:{id}`, `cacheLife` 5/10/300 с, `connection()` — данные не пререндерятся, сборка не требует бэкенда); маршруты `/library` (вкладки Артисты·Альбомы·Треки через `?tab=`, чипы статусов `?status=all|playable|adding|not_found`, «Показать ещё» по `next_cursor`), `/artist/[id]`, `/album/[id]` (шапка, сводка статусов, прогресс, приглушённые треки вне библиотеки с «+», «Добавить весь альбом», удаление с подтверждением), главная («Недавно добавленные» 12 альбомов, «Готово к прослушиванию», CTA «Найдите музыку» с ⌘K), `not-found` для артиста/альбома, `error.tsx` с понятным сообщением; `TrackStatusBadge` (иконки + tooltip из таблицы плана, прогресс «Проверяем раздачи 3/7»), `LibraryTrackRow` (Play активен только для `found`/`ready`); `LiveLibrarySync` (`providers/live-library-provider.tsx`: store `trackStatus`/`albumProgress`, debounce `router.refresh()` + `revalidateLibrary` — 2 с для `track.status`, 1 с для `library.changed`/`resync`). Кнопка «Добавить» в поиске теперь настоящая (toast «Импортируем дискографию…» для артиста, `clearSearchCache()` после успеха).
- Сделано (backend): `GET /api/library/tracks?status=` принимает список через запятую (`found,ready`); **исправлена схема OpenAPI для `TrackStatus`** — derive `utoipa` в макросе `text_enum` не видел `serde(rename)` и публиковал `Adding/Found/…` вместо `adding/found/…` (баг шага 07, поймал типизированный клиент); теперь `PartialSchema`/`ToSchema` реализованы вручную, тест проверяет значения enum в спецификации. `web/openapi.json` и `schema.d.ts` перегенерированы.
- Тесты: 22 Playwright (9 новых в `tests/library.spec.ts` + прежние). Вместо реального бэкенда — мок `web/tests/mock-backend.mjs` (серверные компоненты ходят на `BACKEND_URL` с сервера Next, `page.route` их не перехватывает); `playwright.config.ts` поднимает мок (порт 4010) и dev-сервер с `BACKEND_URL`/`NEXT_PUBLIC_BACKEND_URL` на него; WebSocket подменяется `page.routeWebSocket`. Покрыто: добавление из поиска → библиотека → альбом со спиннерами, статусы и доступность Play, live `job.progress`/`track.status` без перезагрузки (и что отложенный refresh не затирает live-статус), «+» для треков вне библиотеки, чипы статусов, «Показать ещё», страница артиста, удаление с подтверждением, 404/500, главная. С живым бэкендом и настоящим MB: добавлен OK Computer → 12 треков со спиннерами, консоль браузера чистая.
- Отклонения: `zustand` не добавлялся (store — React context). Overrides статусов из WS живут до конца сессии вкладки (серверное значение их не сбрасывает; `resync` очищает). Состояние мока общее для тестов (без reset между ними): тесты не опираются на «пустую» библиотеку; тест поиска принимает и «Добавлено», и «Уже в библиотеке». 404 внутри `'use cache'` возвращается как `null` (класс `ApiError` теряется на границе кэша), `notFound()` вызывается снаружи. Ссылка в Library сайдбара не подсвечивается на подстраницах (`/album/*`, `/artist/*`). Полный прогон e2e занимает ~5 минут (холодная компиляция dev-сервера).
- Важно для следующих шагов: плеер (шаг 19) получает `Track` через `toPlayerTrack(TrackDto)`; `LibraryTrackRow` уже играет только `found`/`ready` и строит очередь из `found`/`ready` треков списка. Стриминг/`stream.progress` можно показывать так же через store в `live-library-provider`. Для ручного запуска e2e: `PLAYWRIGHT_CHROMIUM_PATH=<chrome> pnpm test:e2e` (мок и dev-сервер поднимаются автоматически; порты 4010 и 3002).

### 2026-11-11 — шаг 10
- Сделано: новый крейт `nimbus-library` (`LibraryService`: `ensure_artist/ensure_album`, `add_album/add_track/add_artist`, `import_artist`, `remove`; `AddOutcome`, `LibraryError`, константа `EXCLUDED_SECONDARY_TYPES`); `Job::ImportArtist { artist_id }` + `ImportArtistHandler` в `worker` (concurrency 1, использует `ctx.mb.background()`; `MbUnavailable` → `Retry` через 60 с); `JobCtx` получил поле `mb: MbClient`; `MbClient::recording(mbid)`; `db::repo::views` (ArtistView/AlbumView/TrackView, keyset-пагинация по `(added_at, id)`), `tracks/albums::set_in_library_for_album|artist`, `albums::get_by_rg_mbid`; API: `POST /api/library` (201 added / 202 importing / 200 exists), `DELETE /api/library/{type}/{id}`, `GET /api/library/{artists,albums,tracks}`, `GET /api/artists/{id}`, `/api/albums/{id}`, `/api/tracks/{id}`, DTO и ошибки (`mb_not_found` 404, `mb_unavailable` 503, `recording_not_in_release` 422, `bad_type`/`bad_cursor`/`bad_limit`/`bad_status`/`bad_request` 400) в OpenAPI; `web/openapi.json` и `web/lib/api/schema.d.ts` обновлены. События `library.changed` (и `track.status` при сбросе `not_found → adding`). Тесты: 11 интеграционных (`crates/api/tests/library.rs`) + `recording()` + unit `Job::ImportArtist`; весь workspace и `backend-check` зелёные. С живым MB: POST OK Computer → 201 за 3.6 с, `GET /api/albums/1` — 12 треков `adding`, затем `discover_album` выполнена заглушкой.
- Отклонения и решения: (1) трек, которого нет в треклисте выбранного альбома, → `422 recording_not_in_release` (вне треклиста не создаётся). (2) `AlbumDto.track_count` и `status_counts` считаются по **всем** трекам альбома (не только добавленным в библиотеку); `ArtistDto.album_count` — альбомы, где хоть что-то в библиотеке, `track_count` — треки в библиотеке. (3) Повторный POST уже добавленного альбома/трека/артиста возвращает 200 `exists` без новых задач — «ретрай» not_found пойдёт отдельным эндпоинтом (шаг 20); но снятие и повторное добавление альбома сбрасывает `not_found → adding`. (4) При импорте артиста пропускаются совместные release group'ы, где первым в `artist-credit` указан другой артист (иначе в библиотеку попал бы и он); группы без релизов в MB пропускаются с предупреждением, сетевые ошибки повторяют всю задачу (импорт идемпотентен). (5) `ensure_album` принимает необязательный `ReleaseGroupHit` (импорт артиста передаёт данные из browse — экономит запрос на каждый альбом). (6) Курсор — непрозрачная строка `<rfc3339 µs>|<id>`; Json-ошибки разбора тела приводятся к `400 bad_request` через `extract::ApiJson`. (7) `AppState` получил поле `library: LibraryService` (создаётся в `AppState::new`).
- Важно для следующих шагов: фронтенд (шаг 11) может брать типы из `schema.d.ts` (`AddToLibraryRequest`, `AlbumDetailDto` и т.д.). Задачи `discover_album/discover_artist/verify_torrent` по-прежнему заглушки; `ImportArtist` ставит `DiscoverArtist` в конце, а `add_album/add_track` — `DiscoverAlbum` (шаг 14 заменит заглушки). Для статусов треков используйте `nimbus_db::helpers::set_track_status_and_publish`. Фикстуры MB для тестов библиотеки — `crates/musicbrainz/tests/fixtures/` (`artist_release_groups_import`, `releases_browse_ep`, `release_ep`, `recording_lookup`); хелперы запросов в `crates/api/tests/common` (`post_json`, `delete`, `request_json`).

### 2026-11-11 — шаг 09
- Сделано: `hooks/use-search.ts` (debounce 350 мс, отмена устаревших запросов через `AbortController`, кэш `Map` на сессию — ответы с непустым `errors` не кэшируются, статусы `idle|loading|success|error`, `stale` — при загрузке показываются предыдущие результаты приглушённо, `retry()`); страница `/search` (`features/search/components/search-view.tsx`, `search-results.tsx`: «Лучший результат» + треки, «Артисты» (инициалы на градиенте от mbid), «Альбомы», «Треки», скелетоны, пустое состояние, ошибка + «Повторить», `errors[]` частичных ответов; `?q=` синхронизируется через `router.replace`); элементы с `library_id` помечены «В библиотеке» и ведут на `/artist/{id}`, `/album/{id}` (страниц пока нет — шаг 11); командная палитра ⌘K/Ctrl+K (`features/search/components/command-palette.tsx`, провайдер в `app/(app)/layout.tsx`, на `@ariakit/react` Dialog — фокус-ловушка и Esc; `role="combobox"`/`listbox`/`option`, `aria-activedescendant`, стрелки циклически, Enter, Shift+Enter, «Показать все результаты», до 3/3/5 элементов); `AddToLibraryButton` (`useOptimistic` + `useTransition`, спиннер → галочка/откат) и Server Function-заглушка `addToLibrary` в `app/actions/library.ts` (тип `AddToLibraryInput` зафиксирован, при ошибке toast «Скоро будет»); подсказка `⌘K` в сайдбаре. Тесты: `tests/search.spec.ts` (9 Playwright-тестов с моком `**/api/search*` по `tests/fixtures/search-radiohead.json`: три секции, отметки, debounce/кэш, приглушение, ошибка, toast, палитра: открытие, стрелки, Enter, Esc, Shift+Enter); все 12 e2e-тестов, `just web-check`, `pnpm build` проходят. С живым бэкендом и настоящим MB: «radiohead» → результаты за ~3.3 с (с учётом набора), повтор — 14 мс.
- Отклонения: SSE не использовался (его нет в бэкенде, шаг 07). `cmdk` не добавлялся (свой список поверх Ariakit Dialog). Отдельного unit-теста `useSearch` нет (в проекте нет vitest) — дебаунс/кэш проверены Playwright-тестом. Удалены ставшие ненужными `components/scripts/seed-from-search-param.tsx` и `hooks/use-sync-input-to-search-param.ts`. Треки в результатах поиска не проигрываются (их ещё нет в библиотеке); клик по ним ничего не делает.
- Важно для следующих шагов: чтобы подключить реальное добавление (шаг 11), достаточно заменить тело `addToLibrary` в `app/actions/library.ts` (вход `{type:'artist'|'album'|'track', mbid, album_mbid?}`) и после успеха инвалидировать кэш/обновить `library_id` — кнопка уже держит оптимистичное состояние, а `clearSearchCache()` из `hooks/use-search.ts` сбрасывает клиентский кэш поиска (чтобы «В библиотеке» отобразилось сразу). Реальные ссылки `/artist/{id}` и `/album/{id}` приведены к `Route` кастом — после появления страниц каст можно убрать. Тестовый хелпер `openPalette(page)` повторяет Ctrl+K до открытия диалога (до гидрации обработчик ещё не подключён).

### 2026-11-11 — шаг 08
- Сделано: удалены Prisma (`prisma/`, `generated/`, `lib/db.ts`, зависимости, скрипты), процедурный синтез (`lib/audio`), vgpu-обложки и `scripts/`, `public/covers`, демо-обвязка (`components/demo`, `Boundary`, переключатели), `ai`/`@ai-sdk`, `@vercel/analytics|speed-insights`, логин/cookie/`proxy.ts`, `/api/play`, модуль вывода пользователей и все старые Playwright-тесты. Страницы **жанров, плейлистов, избранного и трека (`/genre`, `/playlist`, `/favorites`, `/track/[id]`), `/login` удалены** (плейлисты вне MVP; страницу трека/альбома нужно будет сделать заново в шагах 11/19). Оставлены и адаптированы: оболочка (layout, сайдбар только с Home/Search/Library, мобильная навигация, темы, toaster), `NowPlayingBar`, `PlayerProvider` (**заглушка без звука**: `play/pause/resume/next/previous/seek/setVolume`, очередь, прогресс 0–100 — интерфейс `usePlayer()` сохранён для шага 19), списки треков (`TrackRow/TrackList/AlbumCard/PlayButton/TrackPlayRow`, без избранного и меню плейлистов). Новое: `lib/env.ts` (Zod), `lib/api/{client,errors,events,schema.d.ts}` (`openapi-fetch`, `unwrap`/`ApiError`, `LiveEvent`), `lib/data/health.ts` (`'use cache'`, `cacheTag('health')`, `cacheLife('seconds')`), `components/ui/cover.tsx` (`<Cover src alt size fallback>` на `next/image` с `unoptimized`, fallback — градиент + `Disc3`), `providers/live-events-provider.tsx` + `hooks/use-live-events.ts` (`useLiveEvent`, `useConnectionState`, автопереподключение 1→30 с), `components/connection-indicator.tsx` (точка в сайдбаре), `features/library/components/{empty-library,backend-status}.tsx`. `just web-gen-api`, `pnpm gen:api/typecheck`. Брендинг NextBeats → Nimbus. Проверено: `pnpm build` без `DATABASE_URL` и без бэкенда; `pnpm lint`, `tsc --noEmit`, `just check`; 3 Playwright smoke-теста; в браузере при запущенном бэкенде индикатор зелёный, после остановки — серый/страница не падает, после запуска переподключается (1 с).
- Отклонения: vgpu не оставлен даже как fallback (удалён полностью). Страница `/search` — временная заглушка «Поиск скоро появится» (реализация — шаг 09), `/` и `/library` показывают пустое состояние «Библиотека пуста» + статус бэкенда на главной. В `playwright.config.ts` добавлена переменная `PLAYWRIGHT_CHROMIUM_PATH` (на этой машине Chromium лежит в `~/.cache/ms-playwright/chromium-1228`, версия не совпадает с ожидаемой `@playwright/test` 1.64.1): `PLAYWRIGHT_CHROMIUM_PATH=<путь к chrome> pnpm test:e2e`. Порт Playwright по умолчанию 3002.
- Важно для следующих шагов: `web/.env.local` (не коммитится) указывает на бэкенд `:8081`; в `.env.example` — `:8080`. `ApiError` содержит `status`, `code`; `unwrap(await api.GET(...))`. Типы UI-модели трека — `types/track.ts` (`id: number`, `durationMs`, `coverUrl`, `status`). `NavLink`/`PrefetchLink` теперь всегда делают prefetch (demo-переключатель убран). Для клиентских компонентов с WebSocket подписка — `useLiveEvent('track.status', handler)`; провайдер смонтирован в `app/(app)/layout.tsx`. Next.js 16.4 canary: перед правками читать `web/node_modules/next/dist/docs/`; после удаления маршрутов нужно чистить `.next`, иначе `tsc --noEmit` падает на устаревших `.next/types/validator.ts`.

### 2026-11-11 — шаг 07
- Сделано: `utoipa` 5 подключён; `GET /api/openapi.json`, `nimbus --print-openapi` (разбор до подключения к БД), `just openapi` → `web/openapi.json` (закоммичен); `GET /api/search?q=&types=&limit=` (три запроса к MB конкурентно, общий таймаут 12 с с частичной выдачей в `errors`, обогащение `library_id`/`status` одним SQL на тип; `q` < 3 символов → только артисты; ошибки `bad_query`/`bad_limit`/`bad_types`). В OpenAPI зарегистрированы `/api/health`, `/api/search`, `/api/ws`, `/api/debug/jobs`; DTO ошибок `ErrorResponse`. Тесты: 7 интеграционных поиска/OpenAPI (wiremock + `#[sqlx::test]`) + unit; `health`/`ws` тесты переведены на `tests/common`. Вручную с живым MB: `q=radiohead` → «Radiohead», 3/3/3 результата, холодный запрос 2.35 с, повторный 20 мс (кэш).
- Отклонения: SSE `/api/search/stream` и Swagger UI не делались (необязательные). `TrackStatus` и прочие text-enum'ы в `core` получили `utoipa::ToSchema` (зависимость `utoipa` в `core`). Эндпоинт `/api/debug/jobs` описан с `body = Object`. Лимит > 25 или < 1 отклоняется (400 `bad_limit`), а не обрезается.
- Важно для следующих шагов: **каждый новый эндпоинт и DTO нужно добавлять в `openapi::ApiDoc` (`paths(...)`, `components(schemas(...))`)** и после изменений запускать `just openapi`. `AppState::new(db, config, events, mb)` — единственный конструктор (+ поле `search_timeout`); `AppState.mb` — интерактивный `MbClient` (для фоновых задач — `state.mb.background()`). Для тестов API есть общий `crates/api/tests/common` (`state`, `state_with_mb`, `mb_client` на wiremock, `get_json`). Пути в `#[utoipa::path]` указываются полностью (`/api/...`).

### 2026-11-11 — шаг 06
- Сделано: крейт `nimbus-musicbrainz`: `MbClient` (`Clone`, общий лимитер/кэш/single-flight), `get_json` (кэш `mb_cache` → single-flight через `Shared` → лимитер → HTTP, повторы 503/429 до 3 раз с `Retry-After`/2 с), приоритеты (`Interactive` по умолчанию, `client.background()` для массовых lookup'ов; лимитер собственный, а не `governor`, интервал 1.1 с настраивается), `lucene_escape` и `search_query` (термы + `*` на последнем ≥ 3 символов), методы `search_artists/release_groups/recordings`, `artist`, `release_group`, `artist_release_groups` (пагинация по 100), `pick_canonical_release` (+ `score_release`/`pick_canonical`, запасной запрос без `status=official`), `release_tracklist`, `cover_url`. TTL: поиск 24 ч, lookup 7 дней. Тесты: 9 unit + 19 интеграционных (wiremock + `#[sqlx::test]`: парсинг, 503→успех, исчерпание повторов, 404, single-flight, кэш и TTL, интервал лимитера, приоритет, пагинация, реальные ответы) + 1 живой `#[ignore]` — прошёл (`cargo test -p nimbus-musicbrainz -- --ignored`).
- Отклонения: в `ArtistHit` добавлено поле `sort_name: Option<String>` (нужно `NewArtist` на шаге 10). Лимитер реализован вручную (без `governor`). Фикстуры: сценарные (`tests/fixtures/*.json`) составлены вручную по формату MB — на них проверяются детерминированные сценарии; рядом лежат реальные ответы `real_*.json` (записаны 2026-11-11), на них проверяется, что разбор работает с настоящим API. При записи фикстур MB временно отказывал в TLS-соединении после серии запросов подряд (7 за ~10 с) и отвечал «throttled» — запросы к реальному API нужно держать ≥ 1 с друг от друга (в тестах/скриптах 3 с).
- Важно для следующих шагов: `MbClient::new(&config.mb_user_agent, Some(pool))`; для фоновых задач (шаги 10, 14) использовать `client.background()`, для запросов пользователя (шаг 07) — сам клиент. `artist_release_groups(artist, &["album","ep"])`. Ошибки — `MbError` (`NotFound`, `RateLimited`, `Http`, `Transport`, `Parse`), он `Clone`. `release_tracklist` отдаёт `disc_no` из `media[].position`, длина — `track.length` либо `recording.length`. `RecordingHit.release_group_mbid` выбирается по правилу Album без secondary types > EP > Single > прочее, Official раньше, ранняя дата.

### 2026-11-11 — шаг 05
- Сделано: `core::jobs::Job` (+ `to_parts/from_parts`, `dedup_key`), `core::events::{Event, EventBus, JobStage, Entity}`; `db::repo::jobs` (`enqueue` с `pg_notify` в одном операторе, `claim`, `complete`, `fail`, `requeue_stale`, `purge_done`, `list`), `db::helpers::set_track_status_and_publish`; `worker::{JobHandler, JobError, JobCtx, WorkerConfig, WorkerPool}` (LISTEN/NOTIFY + опрос раз в 5 с, backoff `30с·2^(n-1)` до 30 мин, паника изолирована через `tokio::spawn`, graceful shutdown 10 с, обслуживание очереди раз в минуту) и заглушки handler'ов (`discover_*` ×2, `verify_torrent` ×4); `api`: `GET /api/ws` (ping 25 с, таймаут 60 с, `{"type":"resync"}` при Lagged), `GET /api/debug/jobs?state=&limit=`, гард `auth::authorize` (пока пропускает всех), `AppState.events`. Тесты: 5 (очередь) + 5 (раннер) + 3 (WS/debug) + unit'ы; весь workspace и `backend-check` зелёные. Вручную: задача, вставленная в БД, подхвачена воркером и завершена, shutdown корректный.
- Отклонения: в `JobError` добавлен третий вариант `Unexpected(String)` (backoff по умолчанию; `From<anyhow::Error>` и `From<sqlx::Error>`). `WorkerPool::spawn(ctx, Vec<(Arc<dyn JobHandler>, concurrency)>, WorkerConfig)` — параллелизм задаётся парой с обработчиком, а не по виду задачи. `/api/debug/jobs` включается при `debug_assertions` или `NIMBUS_DEBUG=true` (новое поле `Config.debug`, переменная в `.env.example`). `websocat` в окружении нет — WS проверен интеграционным тестом на `tokio-tungstenite`.
- Важно для следующих шагов: чтобы добавить реальный handler, замените заглушку в `worker::handlers::default_handlers()` (шаги 14, 17) и расширьте `JobCtx`. Новые виды задач — вариант в `core::jobs::Job` + константа `kind`. `AppState` теперь требует `events` (тесты создают его вручную). Для публикации статуса трека используйте `nimbus_db::helpers::set_track_status_and_publish`. Тестовый шаблон для раннера — `crates/worker/tests/runner.rs`.

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
