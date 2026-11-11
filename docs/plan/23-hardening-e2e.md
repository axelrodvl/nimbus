# Шаг 23 — Авторизация, e2e, полный docker-compose, README

**Зависит от:** 22
**Оценка:** 2 дня

## Цель

Довести проект до состояния «можно развернуть у себя»: простая авторизация, весь стек в docker compose, сквозные e2e-тесты, CI, документация.

## Что сделать

### 1. Авторизация (однопользовательская)

- Если задан `NIMBUS_API_TOKEN` — все `/api/*`, кроме `/api/health`, требуют токен:
  - заголовок `Authorization: Bearer <token>`, **или**
  - cookie `nimbus_token` (HttpOnly, SameSite=Lax) — нужна для `<audio src>` и WebSocket, которые не умеют слать заголовки;
  - для WS дополнительно допускается `?token=` в URL.
- Сравнение — за постоянное время (`subtle::ConstantTimeEq`).
- `POST /api/auth/login { token }` → ставит cookie; `POST /api/auth/logout`.
- Фронтенд: страница `/login` (одно поле), `proxy.ts` (Next 16 middleware) перенаправляет на `/login`, если нет cookie; серверные запросы к бэкенду пробрасывают токен (из cookie запроса). Если бэкенд и фронт на разных origin — cookie должна ставиться на домен бэкенда: либо держать их под одним доменом через reverse proxy (см. п. 2, **рекомендуется**), либо логиниться напрямую в бэкенд из браузера (`credentials: "include"`, CORS `allow_credentials`).
- Без токена (по умолчанию) — всё открыто, но в логах при старте warning, если `NIMBUS_BIND` не на `127.0.0.1`.

### 2. Полный docker compose

```yaml
services:
  db:       # из шага 01
  backend:
    build: ./backend
    env_file: .env
    environment:
      DATABASE_URL: postgres://nimbus:nimbus@db:5432/nimbus
      NIMBUS_DATA_DIR: /data
    volumes: [ "./data:/data" ]
    ports: [ "6881:6881/tcp", "6881:6881/udp" ]   # входящие BitTorrent-соединения
    depends_on: { db: { condition: service_healthy } }
  web:
    build: ./web          # Dockerfile: next build с output: "standalone"
    environment:
      BACKEND_URL: http://backend:8080
      NEXT_PUBLIC_BACKEND_URL: ""                 # тот же origin через caddy
  caddy:                   # единый origin: / → web, /api → backend (включая WS и стрим)
    image: caddy:2
    ports: [ "8000:80" ]
    volumes: [ "./deploy/Caddyfile:/etc/caddy/Caddyfile:ro" ]
```
- `deploy/Caddyfile`: `handle /api/* { reverse_proxy backend:8080 { flush_interval -1 } }` (без буферизации — важно для стрима), `handle { reverse_proxy web:3000 }`.
- Поддержать `NEXT_PUBLIC_BACKEND_URL=""` (относительные URL) во фронтенде — проверить `lib/env.ts`, WS-URL строить от `location`.
- `web/Dockerfile` — multi-stage на `node:22-alpine`, `pnpm`, `output: "standalone"` в `next.config.ts`.
- Рецепты `just up` / `just down` / `just logs`.
- Раздел в README про VPN: трафик BitTorrent можно пустить через контейнер-VPN (например, `network_mode: service:gluetun`) — дать пример в комментарии compose, не включать по умолчанию.

### 3. E2E

`web/tests/e2e/full-flow.spec.ts` — против реального стека (compose), но с **фейковыми** внешними сервисами, чтобы тест был детерминированным:
- в бэкенде режим `NIMBUS_FAKE_EXTERNAL=true` (только для тестов, фича `test-fakes` в Cargo): MB-клиент читает фикстуры из шага 06, провайдер торрентов возвращает одну раздачу, движок — локальный сидер из шага 15 (или фейк поверх файлов-фикстур из шага 18/19: `sine.mp3`);
- сценарий: логин → `⌘K` «radiohead» → добавить «OK Computer» → дождаться `found` у первого трека (WS) → Play → `audio.currentTime > 1` → дождаться `ready` → перезагрузить страницу → трек `ready`.
- `just e2e` поднимает compose с override-файлом `docker-compose.e2e.yml` и запускает Playwright (`--trace off`).

### 4. CI (`.github/workflows/ci.yml`)

Jobs: `backend` (Postgres service, `cargo fmt --check`, `clippy -D warnings`, `cargo test`), `web` (`pnpm install --frozen-lockfile`, lint, typecheck, build, Playwright без e2e), `e2e` (опционально, по ручному запуску). Проверка, что `web/openapi.json` совпадает с `nimbus --print-openapi` (иначе ошибка «перегенерируй типы»).

### 5. Наблюдаемость

- `GET /api/health` дополнить: `engine: { torrents, down_bps, up_bps }`, `jobs: { queued, running, failed_24h }`.
- Логи в JSON при `NIMBUS_LOG_FORMAT=json`.

### 6. Документация

- `README.md`: возможности, скриншоты (Playwright, deviceScaleFactor 2), быстрый старт (`cp .env.example .env && just up` → http://localhost:8000), настройка провайдеров, RuTracker (cookie при капче, прокси), Jackett/Prowlarr, VPN, ограничения (холодный старт 5–30 с, мёртвые раздачи), **юридическое предупреждение** (скачивание и раздача защищённого авторским правом контента может быть незаконным; проект — для личного использования с контентом, на который у вас есть права).
- `docs/architecture.md` — актуальная схема (можно вынести из `PLAN.md`), описание конвейера и статусов.
- `docs/api.md` — ссылка на `/api/docs` (Swagger) и описание WS-событий.

## Критерии приёмки

- `just check`, `just test` проходят; `just e2e` проходит.
- `docker compose up --build` поднимает весь стек; http://localhost:8000 открывается, поиск и воспроизведение работают (вручную, с реальными сервисами — если сеть позволяет).
- С `NIMBUS_API_TOKEN` без логина API отвечает `401`, после логина всё работает, включая аудио и WS.

## Вне рамок шага

Зеркало MusicBrainz (шаг 24).
