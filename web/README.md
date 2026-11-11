> Fork of nextjs/next-beats (MIT)

# Nimbus — web

Фронтенд Nimbus: Next.js 16 (App Router, Cache Components, React 19 + React Compiler), Tailwind v4.
Тонкий клиент Rust-бэкенда (`../backend`): данные приходят по REST (`/api/*`), события — по WebSocket (`/api/ws`).

## Запуск

```bash
cp .env.example .env.local   # BACKEND_URL / NEXT_PUBLIC_BACKEND_URL
pnpm install
pnpm dev                     # http://localhost:3000
```

Бэкенд запускается из корня репозитория: `just db-up && just backend`. Без бэкенда страницы открываются,
индикатор соединения в сайдбаре серый.

## Команды

| Команда | Что делает |
|---|---|
| `pnpm gen:api` | генерирует `lib/api/schema.d.ts` из `openapi.json` (сам файл обновляется командой `just openapi` из корня) |
| `pnpm lint` / `pnpm typecheck` | ESLint / `tsc --noEmit` |
| `pnpm build` | production-сборка (бэкенд для сборки не нужен) |
| `pnpm test:e2e` | Playwright smoke-тесты |

## Структура

- `lib/api/` — типизированный клиент (`openapi-fetch`), `unwrap`/`ApiError`, типы WebSocket-событий; `schema.d.ts` генерируется, руками не правится.
- `lib/data/` — серверные функции получения данных (`'use cache'` + `cacheTag`/`cacheLife`). Теги кэша: `library`, `artist:{id}`, `album:{id}`, `track:{id}`.
- `providers/` — `PlayerProvider` (пока без звука), `LiveEventsProvider` (WebSocket); хуки — `hooks/use-live-events.ts`.

## License

[MIT](LICENSE)
