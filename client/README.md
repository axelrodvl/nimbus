# Nimbus client

Одностраничное приложение (Vite + React 19 + TypeScript) на bun. Заменит `web/` (Next.js) на шаге 48;
правила — `docs/DEVELOPMENT.md` §5–6. Сейчас — каркас: токены дизайна, примитивы, темы, i18n, API-слой, тесты.

## Команды

Из корня репозитория: `just client` (dev, :5173, прокси `/api` → `VITE_BACKEND_URL`, по умолчанию `http://localhost:8080`),
`just client-check` (lint + typecheck), `just client-test`, `just client-cov` (пороги в `vitest.config.ts`),
`just client-build`, `just client-e2e` (Playwright против `vite preview` и `tests/mock-backend.ts`),
`just client-gen-api` (OpenAPI → `src/lib/api/schema.d.ts`).

В каталоге `client/`: `bun install --frozen-lockfile`, `bun run dev | build | lint | typecheck | test | test:cov | test:e2e | gen:api`.
Один раз для e2e: `bunx playwright install chromium`.

## Структура

```
index.html               корень; инлайн-скрипт темы ставит класс до первой отрисовки
src/main.tsx app.tsx router.tsx
src/styles/              tokens.css (@theme), base.css, animations.css, index.css
src/components/ui/       примитивы (button, skeleton, spinner, empty/error-state, error-boundary, …)
src/screens/             экраны (шаги 39+)
src/lib/api/             openapi-fetch клиент, ApiError, сгенерированный schema.d.ts (не править)
src/lib/platform/        apiUrl()/wsUrl()/authHeaders()/platform() — единственное место адресов бэкенда
src/lib/i18n/            словари (en в бандле, остальные — по требованию), store, провайдер, useT/useLocale
src/lib/db/              IndexedDB `nimbus` (idb): loadAll/applyBatch/replaceAll/outbox, запасной режим в памяти
src/lib/store/           library (zustand vanilla, Table + индексы), selectors, live, mutations, hooks
src/lib/sync/            движок синхронизации (снимок/дельта/события), вкладки (Web Locks + BroadcastChannel), статус
src/lib/app-data.ts      сборка db + store + движок + мутации; `appData()` — синглтон, `bootstrap()` (подключит шаг 38)
src/lib/theme/           light | dark | system, localStorage['nimbus:theme']
src/test/                setup, renderWithProviders, фабрики
tests/e2e/               Playwright; tests/mock-backend.ts — мок бэкенда (каждый шаг его дополняет)
```

## Соглашения

- Алиас `@/` → `src/`. Тексты — только через `useT()` и словари; новый ключ — во **все** языки.
- Адреса бэкенда — только через `@/lib/platform/urls`; литерал `'/api/…'` вне `lib/platform` и `lib/api` запрещён линтом.
- Сеть из `src/screens` и `src/components` — только через `src/lib/**` (линт запрещает `fetch` и импорт `@/lib/api/client`).
- Инструменты запускаются под Node (vitest, playwright, eslint — через `bun run`), сборка и установка — bun.
