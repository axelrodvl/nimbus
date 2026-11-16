# Эксплуатация

Для тех, кто запускает Nimbus дома или на сервере. Разработка — `docs/DEVELOPMENT.md`, устройство — `docs/architecture.md`.

## Состав и порты

| Что | Где | Порт |
|---|---|---|
| Интерфейс и API (один origin) | контейнер `nimbus`, `NIMBUS_BIND` | 8080 внутри, `NIMBUS_PORT` на хосте (по умолчанию 8000) |
| BitTorrent (входящие) | контейнер `nimbus` | `NIMBUS_TORRENT_PORT` (6881, TCP и UDP) |
| PostgreSQL | контейнер `db` | 5432 внутри, `POSTGRES_PORT` на хосте (для разработки) |

## Тома и данные

- `pgdata` (Docker-том) — база: библиотека, очередь задач, кэш MusicBrainz, настройки, закрепления.
- `./data` → `/data` (`NIMBUS_DATA_DIR`) — скачанные торренты и кэш (`torrents/`), состояние движка (`session/`),
  файлы `.torrent`. **Резервная копия — оба**: том БД (`docker compose exec db pg_dump -U nimbus nimbus > nimbus.sql`)
  и каталог `data/`. Файлы можно скачать заново, а вот закрепления, плейлисты и настройки живут только в БД.
- Восстановление: `docker compose up -d db`, `docker compose exec -T db psql -U nimbus nimbus < nimbus.sql`, вернуть `data/`, `./scripts/start.sh`.
- Обновление: `./scripts/stop.sh && ./scripts/build.sh && ./scripts/start.sh` (миграции БД применяются при старте, только вперёд) или,
  для опубликованных образов, `./update.sh [версия]` (перезапускает стек, только если вышли новые образы) или `./stop.sh && ./start.sh [версия]` (корневые скрипты работают с `deploy/docker-compose.release.yml`; версия — аргумент или `NIMBUS_VERSION`).

## Переменные окружения

Читает `nimbus_core::config` (`backend/crates/core/src/config.rs`) и `main.rs`. Список проверяется скриптом
`scripts/check-docs.ts` (входит в `just check`): переменная в коде без строки здесь — ошибка. Пример — `.env.example`.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `DATABASE_URL` | — (обязательна) | Строка подключения PostgreSQL. |
| `NIMBUS_BIND` | `0.0.0.0:8080` | Адрес и порт HTTP. Не loopback без токена — предупреждение при старте. |
| `NIMBUS_DATA_DIR` | `./data` | Каталог данных (торренты, кэш, сессия движка). |
| `NIMBUS_WEB_DIR` | не задан (в образе `/app/web`) | Каталог собранного SPA; не задан — только API. |
| `NIMBUS_CORS_ORIGIN` | `http://localhost:3000` | Origin для CORS; нужен только в разработке, когда Vite на другом порту. |
| `NIMBUS_API_TOKEN` | пусто | Токен доступа к `/api/*`. Пусто — всё открыто. Выставляя Nimbus в интернет, задайте токен и TLS-прокси. |
| `NIMBUS_MB_USER_AGENT` | `Nimbus/0.3 ( https://github.com/axelrodvl/nimbus )` | Лучше укажите свой контакт (почта или URL): MusicBrainz ограничивает общие User-Agent (503 «throttled», таймауты). |
| `NIMBUS_TPB_ENABLED` | `true` | Провайдер TPB (apibay). |
| `NIMBUS_TORZNAB_URL` | пусто | Адрес Torznab (Jackett/Prowlarr); пусто — выключен. |
| `NIMBUS_TORZNAB_API_KEY` | пусто | Ключ Torznab. |
| `NIMBUS_RUTRACKER_USERNAME` | пусто | Логин RuTracker. |
| `NIMBUS_RUTRACKER_PASSWORD` | пусто | Пароль RuTracker. |
| `NIMBUS_RUTRACKER_COOKIE` | пусто | Cookie вместо пароля (если нужна капча). |
| `NIMBUS_RUTRACKER_PROXY` | пусто | Прокси к RuTracker, например `socks5://host:1080`. |
| `NIMBUS_CACHE_LIMIT_GB` | `50` | Лимит кэша торрентов; закреплённое вытеснению не подлежит и может его превышать. |
| `NIMBUS_SEEDING` | `true` | Раздавать после скачивания. |
| `NIMBUS_SEED_RATIO` | `1.0` | Лимит раздачи (`0` или `none` — без лимита). |
| `NIMBUS_TORRENT_PORT` | `6881` | Порт входящих BitTorrent-соединений; `0` — случайный; занят — движок выберет случайный. |
| `NIMBUS_DEBUG` | `false` | Включает `/api/debug/*` в release-сборке. |
| `NIMBUS_FFMPEG` | `ffmpeg` | Путь к ffmpeg (перекодирование CUE, APE/WV/DSD, ALAC). В образе есть. |
| `NIMBUS_LOG_FORMAT` | текст | `json` — структурные логи. Уровень — стандартная `RUST_LOG`. |
| `NIMBUS_PORT` | `8000` | Только docker compose: порт интерфейса на хосте. |
| `NIMBUS_VERSION` | `latest` | Только `deploy/docker-compose.release.yml`: версия образов GHCR. |

User-Agent и дополнительные заголовки RuTracker (`providers.rutracker.user_agent`, `providers.rutracker.headers`) задаются только в интерфейсе или через `PUT /api/settings`: вместе с `cf_clearance` в cookie они нужны, чтобы пройти Cloudflare-челлендж (см. README, «RuTracker»).

Остальные настройки (источники, лимиты MusicBrainz, производительность, плеер, хранилище) — в интерфейсе («Настройки»)
или `PUT /api/settings`; они хранятся в БД и накладываются поверх значений из окружения.

### Только для тестов (сборка с `test-fakes`)

Образ `nimbus:e2e` (`just e2e`, `just load`) умеет заменять внешние сервисы фейками; в боевой сборке эти переменные
вызывают ошибку старта.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `NIMBUS_FAKE_EXTERNAL` | `false` | Включает фейковые MusicBrainz, Torznab и локальный сидер. |
| `NIMBUS_FAKE_ARTISTS` | 0 | > 0 — синтетический каталог из N артистов вместо фикстур. |
| `NIMBUS_FAKE_ALBUMS_PER_ARTIST` | 15 | Альбомов у артиста. |
| `NIMBUS_FAKE_TRACKS_PER_ALBUM` | 12 | Треков в альбоме (1–99). |
| `NIMBUS_FAKE_SWARM_ALBUMS` | 40 | У скольких первых альбомов есть раздача (маленькие WAV); остальные «не находятся». |
| `NIMBUS_FAKE_LATENCY_MS` | 0 | Задержка каждого ответа фейков. |
| `NIMBUS_FAKE_FAILURE_RATE` | 0 | Доля ответов 503 (детерминированно, по seed). |
| `NIMBUS_FAKE_SEED` | 1 | Seed отказов. |

## Логи

`docker compose logs -f nimbus` (`just logs`). Поля структурные: `album_id`, `torrent_id`, `info_hash`, `job_id`.
Секреты не логируются. При старте предупреждения: заглушка User-Agent, нет токена на нелокальном адресе, нет ffmpeg.

## Диагностика

- `GET /api/health` (открыт всегда) — `db`, `engine {torrents, down_bps, up_bps}`, `jobs {queued, running, failed_24h}`,
  `providers[]` (`state: open` — предохранитель провайдера разомкнут до `open_until`). Это же healthcheck контейнера.
- `GET /api/jobs?state=&kind=` и экран «Загрузки → Задачи» — очередь: что идёт, что упало и почему (`last_error`), повтор кнопкой.
- `GET /api/acquisition` и «Загрузки → Не найдено» — альбомы без раздач, причина, следующий автоповтор.
- `GET /api/downloads`, `GET /api/storage` — торренты, скорость, занято/лимит, закреплённое.
- `/api/debug/*` — только при `NIMBUS_DEBUG=true`.

### Что наблюдать

| Метрика | Норма | Где |
|---|---|---|
| `jobs.failed_24h` | 0 или единицы с понятной причиной | `/api/health`, «Задачи» |
| `jobs.running` без роста `jobs.queued` часами | зависшая очередь: ищите `running` без heartbeat (> 90 с) | `/api/jobs?state=running` |
| провайдер `open` | кратковременно | `/api/health` |
| подключения к БД | меньше размера пула (`nimbus_db::pool_size`), нет `pool timed out` в логах | `pg_stat_activity` |
| память процесса | растёт с числом активных торрентов, после простоя не растёт | `docker stats` |

### Типичные неполадки

| Симптом | Причина и что делать |
|---|---|
| Альбом «не найден» | Нет раздач или все мертвы: «Загрузки → Не найдено» покажет причину; «Повторить», добавить источник (Torznab, RuTracker), указать свой magnet. Автоповтор идёт сам по расписанию. |
| Трек долго не начинает играть | Холодный старт 5–30 с (поиск пиров и метаданных). Нет пиров — трек остаётся `found` без движения; проверьте проброс `NIMBUS_TORRENT_PORT`. |
| Импорт артиста идёт минуты, MusicBrainz отвечает 503 | Задайте `NIMBUS_MB_USER_AGENT`; для большой библиотеки поднимите своё зеркало MusicBrainz (README). Импорт повторяется сам. |
| `401` на всех запросах | Задан `NIMBUS_API_TOKEN`, а клиент без токена: войдите на `/login`. |
| Нет звука из CUE/APE/DSD | Нет ffmpeg: в Docker он есть; снаружи — `NIMBUS_FFMPEG`. |
| Бэкенд не стартует: «cannot connect» | БД ещё поднимается или неверный `DATABASE_URL`; бэкенд ждёт и повторяет. Во время остановки БД API отвечает 503 и возвращается сам. |
