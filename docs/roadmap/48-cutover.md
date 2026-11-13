# Шаг 48 — Переключение: бэкенд раздаёт SPA, сборка на bun, удаление `web/`

**Фаза 3 · Зависит от:** 40, 42, 44, 47 · **Закрывает находки:** F2, F3, F9

## Зачем

Новый клиент функционально полон. Теперь он становится единственным: бэкенд сам раздаёт собранные
файлы, отдельный сервер Node и обязательный Caddy исчезают, образ один, фронтенд собирается bun.
Старый `web/` удаляется.

## Текущее состояние

- `docker-compose.yml` — сервисы `db`, `backend`, `web` (Next standalone, Node), `caddy` (склейка origin: `/api/*` → backend, остальное → web); `docker-compose.e2e.yml`; `deploy/Caddyfile`, `deploy/docker-compose.release.yml`.
- `backend/Dockerfile` (контекст `./backend`), `web/Dockerfile` (pnpm).
- `scripts/build.sh`, `start.sh`, `stop.sh`, `common.sh` (в т. ч. список образов `built_images`).
- `.github/workflows/ci.yml` (jobs `backend`, `web`, e2e на pnpm, с шага 36 — `client`), `release.yml` (матрица образов `backend`/`web`, пакет для запуска).
- `justfile` — рецепты `web*`, `openapi` (пишет в `web/openapi.json` и `client/openapi.json`), `e2e` (Playwright из `web/`).
- `backend/crates/api/src/lib.rs` — `build_router` (только `/api`), CORS по `NIMBUS_CORS_ORIGIN`; `backend/crates/core/src/config.rs`.
- `web/tests/e2e/full-flow.spec.ts`, `web/playwright.e2e.config.ts` — сквозной сценарий против полного стека.
- `docs/web-inventory.md` — перечень возможностей старого интерфейса; отметки паритета — в Журнале шага 42.
- `README.md`, `CLAUDE.md`, `docs/architecture.md`, `.env.example`.

## Что сделать

1. **Предварительная проверка паритета.** Пройди `docs/web-inventory.md` и Журнал шагов 42–47: каждая возможность старого интерфейса либо есть в `client/`, либо явно снята с объяснением.
   Найдено непокрытое → **остановись**: оставь шаг `[~]`, запиши в Журнал, что именно, и доделай это в рамках шага до удаления `web/`.
2. **Раздача SPA бэкендом** (`crates/api/src/web.rs`, `tower-http` с feature `fs`):
   - переменная `NIMBUS_WEB_DIR` (`core::config`; по умолчанию не задана → бэкенд, как сейчас, отдаёт только API — так работают разработка и тесты);
   - если задана: все запросы **не** под `/api/` обслуживаются из каталога; файла нет и запрос `GET` с `Accept: text/html` → `index.html` (маршруты SPA); файла нет и это не навигация → 404;
   - заголовки: `/assets/*` (файлы с хэшем в имени) — `Cache-Control: public, max-age=31536000, immutable`; `index.html`, `sw.js`, `manifest.webmanifest` — `no-cache`;
     `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`; CSP: `default-src 'self'; img-src 'self' https://coverartarchive.org https://*.archive.org data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'` — и хэш инлайн-скрипта темы из `index.html` в `script-src` (посчитай при старте по содержимому файла) либо вынеси скрипт в отдельный файл;
   - предсжатые файлы: Vite-сборка кладёт рядом `.br` и `.gz` (плагин сжатия на этапе сборки), `ServeDir::precompressed_br().precompressed_gzip()`;
   - неизвестный путь под `/api/` по-прежнему отвечает JSON-ошибкой 404, а не `index.html`;
   - раздача статики **не** требует токена (экран входа должен загрузиться); `require_token` действует только на `/api/`.
3. **Один образ.** `Dockerfile` в корне репозитория (контекст — корень), стадии:
   - `client-build`: `oven/bun:1`, `bun install --frozen-lockfile` (кэш BuildKit для `~/.bun/install/cache`), `bun run build` → `/app/client/dist`;
   - `backend-build`: как сейчас (кэши cargo), контекст `backend/`;
   - итоговый: как сейчас + `COPY --from=client-build /app/client/dist /app/web`, `ENV NIMBUS_WEB_DIR=/app/web`.
   Корневой `.dockerignore` (исключить `target/`, `node_modules/`, `data/`, `.git`). Старые `backend/Dockerfile`, `web/Dockerfile` удалить.
4. **Compose.** `docker-compose.yml`: сервисы `db` и `nimbus` (бывший `backend`; порт `${NIMBUS_PORT:-8000}:8080`, порты BitTorrent, тома, `ulimits` — как были). Сервисы `web` и `caddy` удалить.
   `NIMBUS_CORS_ORIGIN` в compose больше не нужен (один origin) — убрать из окружения; в коде переменная остаётся для режима разработки (Vite на другом порту).
   `docker-compose.e2e.yml`, `deploy/docker-compose.release.yml` — привести в соответствие. `deploy/Caddyfile` — оставить как **необязательный** пример обратного прокси с TLS (один `reverse_proxy nimbus:8080` с `flush_interval -1`), описать в README.
5. **Скрипты.** `scripts/*.sh`: один собираемый образ; сообщения и проверки обновить; `./scripts/start.sh` по-прежнему поднимает http://localhost:8000.
6. **`justfile`.** Удалить `web`, `web-gen-api`, `web-build`, `web-check`; `openapi` пишет только в `client/openapi.json`; `openapi-check` сверяет его; `check`/`test`/`cov` — бэкенд + клиент;
   `e2e` — полный стек в Docker + Playwright из `client/` (конфиг `client/playwright.stack.config.ts`, каталог `client/tests/stack/`).
   Рецепт `dev` — подсказка: `just db-up`, `just backend`, `just client` в трёх терминалах.
7. **Сквозной e2e на полном стеке.** Перенести `web/tests/e2e/full-flow.spec.ts` в `client/tests/stack/` и расширить: вход по токену → поиск → добавление альбома → треки найдены (фейковые провайдеры) → воспроизведение → закрепить на сервере → скачать на устройство → офлайн-воспроизведение.
8. **CI.** `ci.yml`: удалить job `web` и всё про pnpm/Node (Node оставить только если шаг 36 зафиксировал его для Vitest/Playwright — тогда `actions/setup-node` в job `client`); job e2e использует bun и новый рецепт.
   `release.yml`: один образ `nimbus` (матрица платформ сохраняется), пакет для запуска — новый compose.
9. **Удаление старого.** `git rm -r web/`. Поиск по репозиторию (`grep -rn "web/\|pnpm\|next\b\|Next.js\|caddy" --include='*' .` за вычетом `docs/plan/` и истории Журнала) — исправить все живые упоминания.
   Удалить в бэкенде то, что существовало только для Next: проверь `GET /api/internal/raw/…` и прочие внутренние маршруты — если ими пользовался только сервер Next, удалить вместе с тестами; если ffmpeg (перекодирование) — оставить. Эндпоинты постраничных списков `/api/library/*` оставить (ими может пользоваться сторонний клиент), но пометить в `docs/api.md`, что основной способ — синхронизация.
10. **Документация.** `README.md` (архитектура из двух контейнеров, запуск, разработка на bun, обновление со старой версии: «остановить, `./scripts/build.sh`, запустить; данные сохраняются; в браузере приложение обновится само»),
    `CLAUDE.md` (описание проекта: «Фронтенд — React SPA (`client/`, Vite, bun)», команды), `docs/architecture.md` (схема из `docs/architecture-review.md` §5), `docs/DEVELOPMENT.md` §8 (убрать оговорку про `web/`), `.env.example`.
    `docs/web-inventory.md` — перенести в `docs/plan/` как исторический документ.
11. **`ROADMAP.md` → «Сквозные контракты → Каталоги»:** обновить (нет `web/`).

## Тесты (обязательные)

`crates/api/tests/web.rs` (временный каталог с `index.html`, `assets/app-abc123.js`, `sw.js`, предсжатыми копиями):
- `/` и `/album/5` (навигация) → `index.html`, `no-cache`; `/assets/app-abc123.js` → файл, `immutable`; с `Accept-Encoding: br` → `Content-Encoding: br`;
- `/assets/missing.js` → 404 (не `index.html`); `/api/nope` → JSON 404; `/sw.js` → `no-cache`;
- обход каталога (`/../secret`, `/%2e%2e/secret`, `/assets/..%2f..%2fetc/passwd`) → 404/400, содержимое вне каталога не отдаётся;
- при включённой авторизации `/` и `/assets/*` доступны без токена, `/api/library/albums` — 401;
- `NIMBUS_WEB_DIR` не задан → `/` отвечает 404; задан несуществующий каталог → процесс стартует с предупреждением в логе, `/` → 404;
- заголовки безопасности присутствуют на HTML-ответе; CSP содержит хэш инлайн-скрипта.

Стек: `just e2e` (п. 7) зелёный. Все прежние проверки: `just check && just test && just cov`.

## Критерии приёмки

```
just db-up && just check && just test && just cov
./scripts/build.sh && ./scripts/start.sh
curl -fsS http://localhost:8000/api/health && curl -fsS http://localhost:8000/ | grep -q '<div id="root"'
./scripts/stop.sh
just e2e
test ! -d web
```

В Журнал: размер образа (было два — стало один), время холодной и повторной сборки, время `bun install` + `vite build` в контейнере.
Если Docker недоступен в среде выполнения — выполнить всё остальное, оставить `[~]` с `БЛОК: нужна проверка сборки образа и just e2e`.

## Не входит в шаг

- Доработка интерфейса (49), нагрузочные проверки (50).
- TLS и внешний доступ — остаются на стороне пользователя (пример Caddy).

## Подводные камни

- Запасной ответ `index.html` должен срабатывать только для навигации: иначе отсутствующий `.js` вернёт HTML с кодом 200, service worker закэширует его как скрипт, и приложение «сломается навсегда» до ручной очистки.
- Cookie входа ставится с `SameSite=Lax` и без `Domain` — при одном origin всё работает; `Secure` выставляется по `X-Forwarded-Proto` (за обратным прокси с TLS) — упомяни в README, что прокси должен передавать этот заголовок.
- У существующих пользователей зарегистрирован старый `sw.js` из `web/public` на том же origin — новый SW его заменит (шаг 45, п. «Подводные камни»); проверь вручную или тестом, что после переключения старый кэш `nimbus-images-v1` удалён.
- CSP `connect-src 'self'` покрывает WebSocket того же origin только в современных браузерах; для старых Safari нужно явное `ws:`/`wss:` — добавь схему текущего хоста, если тест в WebKit падает.
- Удаляя `web/`, не потеряй файлы, которые клиент должен был скопировать (иконки, фикстуры тестов): сверь `client/public` и `client/tests` до `git rm`.
