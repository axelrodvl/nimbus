# Nimbus

Веб-плеер: метаданные из MusicBrainz, музыка — потоково из торрентов.
Фронтенд — Next.js (`web/`), бэкенд — Rust (`backend/`), БД — PostgreSQL.

> **Юридическое предупреждение.** Скачивание и раздача защищённого авторским правом контента
> может быть незаконной в вашей стране. Проект предназначен для личного использования с
> контентом, на который у вас есть права. Ответственность за использование лежит на вас.

## Возможности

- Поиск артистов, альбомов и треков по MusicBrainz (⌘K / Ctrl+K), обложки из Cover Art Archive.
- Библиотека: добавили альбом или всю дискографию — Nimbus сам ищет раздачи (TPB, Torznab/Jackett/Prowlarr, RuTracker),
  проверяет содержимое и сопоставляет файлы с треками.
- Потоковое воспроизведение прямо из торрента (Range, перемотка), перекодирование через ffmpeg для CUE-образов и APE/WV/DSD.
- Статусы треков в реальном времени (WebSocket): ищем → можно слушать → скачано.
- Ручной выбор источников, свой magnet, повтор поиска.
- Настройки в UI, лимит кэша с вытеснением, предзагрузка следующего трека, опциональная раздача.
- Простая авторизация по токену (однопользовательская).
- Интерфейс на 14 языках: English, Русский, Español, Français, Deutsch, 中文, Português, Italiano, 日本語, 한국어, Українська, Polski, Türkçe, हिन्दी.
  Язык выбирается в «Настройки → Язык интерфейса» (и на странице входа); по умолчанию — по языку браузера (`Accept-Language`), иначе английский.

## Быстрый старт (Docker)

```sh
cp .env.example .env
# по желанию: NIMBUS_API_TOKEN=длинная-случайная-строка
just up            # или: docker compose up -d --build
```

Откройте http://localhost:8000. Caddy отдаёт единый origin: `/` → web, `/api` → backend (включая WebSocket и аудиострим).
Остановить: `just down`, логи: `just logs`. Данные (торренты, кэш) лежат в `./data`, БД — в томе `pgdata`.
Порт 6881 (TCP/UDP) проброшен для входящих BitTorrent-соединений.

### Авторизация

Если задан `NIMBUS_API_TOKEN`, все `/api/*`, кроме `/api/health`, требуют токен:
заголовок `Authorization: Bearer <token>` либо cookie `nimbus_token` (её ставит `POST /api/auth/login`
и страница `/login`; нужна для `<audio>` и WebSocket). Сервер веба получает тот же токен из окружения
(`NIMBUS_API_TOKEN` в compose) и сам ходит с ним в API. **Выставляя Nimbus в интернет, всегда задавайте токен и
ставьте TLS-терминацию (reverse proxy) перед Caddy.** Без токена всё открыто — при старте бэкенд предупреждает,
если слушает не `127.0.0.1`.

## Разработка без Docker

Требования: Rust stable, Node 22+ и pnpm, [just](https://github.com/casey/just), Docker (для PostgreSQL) и ffmpeg.

```sh
cp .env.example .env
just db-up
just backend   # http://localhost:8080/api/health
just web       # http://localhost:3000
```

Если порты 5432/8080 заняты, поменяйте `POSTGRES_PORT`, `DATABASE_URL`, `NIMBUS_BIND`, `BACKEND_URL`,
`NEXT_PUBLIC_BACKEND_URL` в `.env`. При раздельных origin (dev) cookie входа ставится на `localhost` и
не зависит от порта, а CORS открыт для `NIMBUS_CORS_ORIGIN`.

Команды: `just test` (бэкенд), `just check` (fmt + clippy + lint + typecheck), `just e2e` (полный стек в compose с
фейковыми внешними сервисами и локальным сидером; нужен Docker), `just web-gen-api` (перегенерировать типы из OpenAPI).
Логи в JSON: `NIMBUS_LOG_FORMAT=json`. Состояние: `GET /api/health` (БД, движок, очередь задач).

## Провайдеры раздач

Настраиваются в `.env` или в UI («Настройки → Источники», у каждого есть кнопка «Проверить»).

- **TPB** (apibay) — включён по умолчанию (`NIMBUS_TPB_ENABLED`).
- **Jackett / Prowlarr (Torznab)** — `NIMBUS_TORZNAB_URL` (адрес индексера Torznab, например
  `http://jackett:9117/api/v2.0/indexers/all/results/torznab`) и `NIMBUS_TORZNAB_API_KEY`.
- **RuTracker** — `NIMBUS_RUTRACKER_USERNAME`/`NIMBUS_RUTRACKER_PASSWORD`. Если при входе требуется капча,
  войдите в браузере и передайте cookie целиком в `NIMBUS_RUTRACKER_COOKIE`. Если сайт недоступен напрямую —
  `NIMBUS_RUTRACKER_PROXY` (например, `socks5://host:1080`).

## VPN для BitTorrent

Трафик торрент-движка можно пустить через VPN-контейнер, например [gluetun](https://github.com/qdm12/gluetun):
запустите `gluetun` и в `docker-compose.yml` для сервиса `backend` раскомментируйте `network_mode: "service:gluetun"`
(порты и `depends_on` тогда переносятся на `gluetun`, а Caddy проксирует на `gluetun:8080`). По умолчанию выключено.

## Ограничения

- Холодный старт трека — 5–30 секунд (поиск пиров и получение метаданных).
- Раздачи бывают мёртвыми (нет сидов): тогда трек получает статус «не найден» с причиной; можно выбрать другой источник вручную.
- Метаданные берутся с публичного MusicBrainz (лимит 1 запрос/с), поэтому первый поиск может быть медленным.
- Перекодирование (CUE, APE/WV/DSD) требует ffmpeg и не поддерживает перемотку по Range — перемотка идёт новым запросом.

## Переводы интерфейса

Словари лежат в `web/lib/i18n/messages/<язык>.ts`; источник ключей — `en.ts`, остальные файлы типизированы по нему
(`tsc` ругается на пропущенный ключ), а `tests/i18n-unit.spec.ts` проверяет полноту, плейсхолдеры `{name}` и формы
множественного числа для каждого языка. Чтобы добавить язык: новый файл словаря, запись в `lib/i18n/config.ts` и
загрузчик в `lib/i18n/messages.ts`. Язык хранится в cookie `nimbus_locale`; в клиентских компонентах — `useT()`,
в серверных — `await getT()`.

## Документация

- [docs/architecture.md](docs/architecture.md) — схема, конвейер, статусы.
- [docs/api.md](docs/api.md) — REST (схема OpenAPI) и WebSocket-события.
- [PLAN.md](PLAN.md) — план разработки и журнал.
