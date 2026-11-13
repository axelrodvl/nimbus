# Шаг 36 — Каркас `client/`: Vite + React + bun, токены дизайна, тестовая инфраструктура

**Фаза 2 · Зависит от:** 25 · **Закрывает находки:** F2, F8, F9 (частично)

## Зачем

Новый клиент — обычное одностраничное приложение без серверного рендеринга. Этот шаг создаёт пустой, но
полностью оснащённый проект: сборка и скрипты на bun, перенесённые токены дизайна и базовые примитивы,
i18n и темы без Next.js, unit- и e2e-тесты, покрытие с порогом, рецепты `just`, CI. Экранов ещё нет —
следующие шаги только добавляют код в готовую структуру.

## Текущее состояние

- `web/` — Next.js 16 canary. **Не изменяется** на этом шаге (и до шага 48). Из него копируются файлы.
- `web/app/globals.css` — токены (`@theme`), базовые стили, анимации. В `@layer base` есть глобальные стили `input, textarea` и `label` — причина кривых настроек (находка F5); в клиент они **не переносятся**.
- `web/components/ui/*` — примитивы (`button`, `skeleton`, `spinner`, `empty-state`, `error-state`, `error-boundary`, `equalizer`, `marquee`, `music-note`, `collapsible`, `confirm-dialog`).
- `web/lib/i18n/*`, `web/providers/i18n-provider.tsx` — 14 языков, словари `messages/*.ts`, язык хранится в cookie и читается на сервере.
- `web/components/theme/*` — темы через `next-themes`.
- `web/lib/utils.ts`, `web/eslint.config.mjs`, `web/.prettierrc`.
- `web/public/` — иконки, `logo.svg`.
- `justfile`, `.github/workflows/ci.yml`.

## Что сделать

1. **Проект.** Каталог `client/`, `package.json` (`"type": "module"`, `"private": true`), пакетный менеджер — bun (`bun.lock` коммитится).
   Версии — последние стабильные на момент выполнения, без canary/beta:
   - runtime: `react`, `react-dom` (19), `react-router` (7, режим библиотеки — `createBrowserRouter`), `zustand`, `@tanstack/react-query`, `@tanstack/react-virtual`, `idb`, `openapi-fetch`, `@ariakit/react`, `lucide-react`, `sonner`, `clsx`, `tailwind-merge`, `@fontsource-variable/geist`, `@fontsource-variable/geist-mono`;
   - dev: `vite`, `@vitejs/plugin-react`, `babel-plugin-react-compiler`, `tailwindcss` + `@tailwindcss/vite` (v4), `typescript`, `openapi-typescript`, `vitest`, `@vitest/coverage-v8`, `happy-dom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `fake-indexeddb`, `@playwright/test`, `eslint` + `typescript-eslint` + `eslint-plugin-react-hooks`, `prettier` + `prettier-plugin-tailwindcss`.
   React Compiler включить в `@vitejs/plugin-react` (`babel.plugins`) — код из `web/` написан в расчёте на него.
2. **Структура:**
   ```
   client/
     index.html               # корень, инлайн-скрипт темы (п. 6)
     vite.config.ts  vitest.config.ts  playwright.config.ts  tsconfig.json  eslint.config.js
     openapi.json             # копия спецификации бэкенда
     public/                  # иконки, logo.svg (из web/public, без sw.js)
     src/
       main.tsx  app.tsx  router.tsx
       styles/{tokens.css,base.css,animations.css,index.css}
       components/ui/         # примитивы
       components/            # оболочка (шаг 38)
       screens/               # экраны (шаги 39+)
       lib/api/               # клиент API, сгенерированные типы
       lib/i18n/              # словари и провайдер
       lib/theme/  lib/utils.ts
       lib/{db,store,sync,player,offline}/   # появятся в шагах 37, 41, 46
       test/{setup.ts,render.tsx,factories.ts}
     tests/e2e/               # Playwright
     tests/mock-backend.ts    # мок бэкенда для e2e
   ```
   Алиас `@/` → `src/` (и в `tsconfig.json`, и в `vite.config.ts`, и в `vitest.config.ts`).
3. **Скрипты `package.json`:** `dev` (vite, порт 5173), `build` (`tsc --noEmit && vite build`), `preview`, `lint`, `lint:fix`, `format`, `typecheck`,
   `test` (`vitest run`), `test:watch`, `test:cov` (`vitest run --coverage`), `test:e2e` (`playwright test`), `gen:api` (`openapi-typescript ./openapi.json -o ./src/lib/api/schema.d.ts`).
   Dev-сервер проксирует `/api` (включая WebSocket, `ws: true`) на `http://localhost:8080` (переопределяется `VITE_BACKEND_URL`); тот же прокси — в `preview`.
4. **Стили.** `tokens.css` — блок `@theme` из `web/app/globals.css` без изменений значений (шрифты: `--font-sans: 'Geist Variable', …`, `--font-mono: 'Geist Mono Variable', …`).
   `base.css` — `body`, `h1–h3`, правила касаний; **без** глобальных `input`/`textarea`/`label`. `animations.css` — все `@keyframes` и классы анимаций, skeleton, `card-play-btn`, правила `display-mode: standalone`.
5. **Примитивы `src/components/ui/`.** Перенести перечисленные в «Текущем состоянии» компоненты, убрав `'use client'` и зависимости от Next
   (`next/link` → `Link` из `react-router`; `next/image` не использовать). На каждый — компонентный тест (рендер, варианты, доступное имя).
6. **Темы без `next-themes`.** `src/lib/theme/`: значения `light | dark | system`, хранение в `localStorage['nimbus:theme']`, класс `dark` на `<html>`,
   реакция на `prefers-color-scheme` в режиме `system`, синхронизация между вкладками (`storage`). В `index.html` — маленький инлайн-скрипт,
   ставящий класс до первой отрисовки (без вспышки), и `<meta name="theme-color">` для обеих схем. Хук `useTheme()`, компонент `ThemeToggle` (перенос).
7. **i18n без сервера.** Скопировать `messages/*.ts`, `config.ts`, `translate.ts`. Язык: `localStorage['nimbus:locale']` → иначе подбор по `navigator.languages`
   (переиспользуй `negotiateLocale`) → `en`. Словарь `en` — в основном бандле, остальные — `import()` по требованию; до загрузки показывается `en`.
   `I18nProvider`, `useT()`, `useLocale()`, `setLocale()`; атрибут `lang` на `<html>` обновляется. Тест-свойство: во всех словарях одинаковый набор ключей.
8. **API-слой.** `src/lib/api/client.ts`: `openapi-fetch` с базовым URL из `apiBase()` (в PWA — `''`, тот же origin), `credentials: 'include'`; `ApiError { status, code, message }`
   из тела ошибки бэкенда (смотри `web/lib/api/errors.ts`); общий обработчик 401 (колбэк `onUnauthorized`, подключит шаг 38). `schema.d.ts` — сгенерирован, не редактируется, исключён из линта и покрытия.
8a. **Платформенный слой (`src/lib/platform/`)** — задел под нативные оболочки фазы 4; в PWA всё работает как обычный веб.
   - `platform.ts`: `platform(): 'web' | 'ios' | 'android' | 'desktop'` (пока всегда `'web'`), `isNative()`.
   - `urls.ts`: `apiBase()`, `apiUrl(path)` (HTTP), `wsUrl(path)` (WebSocket: схема `ws/wss` от `apiBase()` или `location`). **Единственное** место, где строятся адреса бэкенда: адрес потока, WebSocket, картинки артистов, `download=1` — всё через эти функции. Относительная строка `'/api/…'` вне `src/lib/platform` и `src/lib/api` запрещена правилом линта (`no-restricted-syntax` по литералам, начинающимся с `/api/`).
   - `auth-transport.ts`: `authHeaders(): Record<string, string>` (в PWA — пустой объект; авторизация cookie). Все запросы (`client.ts`, воркер скачивания, WebSocket) получают заголовки отсюда — шаг 52 добавит токен, не трогая вызовы.
   Тесты: `apiUrl`/`wsUrl` для пустой базы и для абсолютной (`https://music.example.com`), правило линта ловит литерал `'/api/x'` в компоненте.
9. **Приложение-заглушка.** `router.tsx` с одним маршрутом `/`, показывающим логотип, название и `ThemeToggle` (оболочку делает шаг 38). `QueryClientProvider` и `I18nProvider` подключены в `app.tsx`.
10. **Unit-тесты.** `vitest.config.ts`: окружение `happy-dom`, `setupFiles: src/test/setup.ts` (jest-dom, `fake-indexeddb/auto`, очистка `localStorage`),
    покрытие v8 по `src/**` с исключениями (`schema.d.ts`, `main.tsx`, `test/**`, `lib/i18n/messages/**`).
    Пороги `coverage.thresholds`: `'src/lib/**': { lines: 90 }`, глобально `lines: 75` (храповик: только вверх).
    `src/test/render.tsx` — `renderWithProviders` (router в памяти, i18n `ru`, QueryClient без повторов).
11. **E2E.** `playwright.config.ts`: сборка + `vite preview` (порт 4173) с прокси на мок; `tests/mock-backend.ts` — перенос `web/tests/mock-backend.mjs`
    на TypeScript (запуск `bun tests/mock-backend.ts`), пока достаточно `/api/health` и `/api/auth/session`; дальше каждый шаг дополняет мок.
    Язык браузера в тестах — `ru-RU`. Один smoke-сценарий: страница открывается, переключение темы меняет класс на `<html>` и переживает перезагрузку.
12. **Линт.** Flat-конфиг: `typescript-eslint` strict, `react-hooks`, запрет `any`. Правило `no-restricted-globals` на `fetch` и `no-restricted-imports` на `@/lib/api/client`
    для `src/screens/**` и `src/components/**` (сеть — только через `src/lib/**`), с понятным сообщением.
13. **`justfile`:** `client` (dev), `client-check` (lint + typecheck), `client-test`, `client-cov`, `client-build`, `client-e2e`, `client-gen-api`.
    `openapi` пишет спецификацию и в `web/openapi.json`, и в `client/openapi.json`; `openapi-check` сверяет оба.
    `check` += `client-check`; `test` += `client-test`; `cov` += `client-cov`.
14. **CI.** Новый job `client`: `oven-sh/setup-bun`, `bun install --frozen-lockfile`, lint, typecheck, `test:cov`, build, установка Chromium для Playwright, `test:e2e --trace off`.
    Существующий job `web` не трогать.
15. **Документация.** `client/README.md` (структура, команды), `README.md` (раздел разработки), `CLAUDE.md` («Полезные команды»: `just client`, `just client-test`).

## Тесты (обязательные)

- тема: начальное значение из `localStorage`; `system` следует за `matchMedia`; смена пишет в `localStorage` и ставит класс;
- i18n: подбор языка, подстановка параметров, запасной `en` для отсутствующего ключа, одинаковые ключи во всех словарях, ленивый словарь подгружается и применяется;
- API-клиент: разбор тела ошибки в `ApiError`; 401 вызывает `onUnauthorized`; сетевой сбой → `ApiError` с `code = 'network'`;
- примитивы — по тесту на компонент;
- e2e smoke (п. 11).

## Критерии приёмки

```
cd client && bun install --frozen-lockfile && bun run lint && bun run typecheck && bun run test:cov && bun run build
just client-e2e
just check && just test && just cov
```

В Журнал: размер сборки (`dist/assets/*.js`, gzip), время `bun install` и `bun run build`.

## Не входит в шаг

- Экраны, хранилище, синхронизация, плеер, service worker.
- Удаление или изменение `web/`.

## Подводные камни

- **Среда выполнения инструментов.** Сначала попробуй запускать всё под bun (`bun --bun vite build`, `bun --bun vitest run`). Если Vitest или Playwright под средой bun нестабильны — оставь для них Node (скрипт без `--bun`), а сборку и установку пакетов держи на bun. Запиши в Журнал, что выбрано и почему; Docker-сборка (шаг 48) использует только `bun install` и `vite build`.
- Пакет `geist` рассчитан на `next/font` — в клиенте используются `@fontsource-variable/*`, подключённые в `styles/index.css`.
- В `web/` порядок ключей объектов навязан линтером (`sort-keys-fix`) — в клиент это правило не переноси.
- Не добавляй зависимости «на будущее»: каждая из п. 1 используется этим или ближайшими шагами; лишнее увеличивает бандл.
- Tailwind v4 настраивается в CSS (`@import 'tailwindcss'`, `@theme`), файла `tailwind.config.*` нет. Вариант `dark` — `@custom-variant dark (&:where(.dark, .dark *));`.
