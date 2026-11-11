# Шаг 08 — Фронтенд: отвязка от Prisma и синтеза, API-клиент

**Зависит от:** 02, 07
**Оценка:** 1.5–2 дня

## Цель

Превратить next-beats в «тонкий» клиент нашего Rust-бэкенда: удалить Prisma, сид и процедурный синтез звука, добавить типизированный API-клиент и WebSocket-хук, переключить страницы на заглушки/реальные данные бэкенда так, чтобы приложение собиралось и открывалось. Главное — **сохранить визуальную оболочку** (layout, навигацию, плеер-бар, темы, списки треков).

## Обязательно прочитать перед началом

`docs/web-inventory.md` (шаг 02) — там перечислены файлы слоя данных, аудио, ключевые компоненты и список «Что удалить в шаге 08».

## Что сделать

### 1. Удаление

- Prisma: `prisma/`, `prisma.config.ts`, `lib/db.ts` (и аналоги), зависимости `@prisma/*`, `prisma`, скрипты `prisma.*` в `package.json`.
- Процедурный синтез Web Audio и всё, что генерирует звук. **Провайдер плеера оставить**, но его «движок» заменить заглушкой: методы `play/pause/seek/next/prev` меняют состояние, звука нет. Шаг 19 подключит реальный `<audio>`.
- Генерацию обложек через vgpu/WebGPU: заменить компонентом `<Cover src={url} alt fallback>` — `<img>` (или `next/image` с `unoptimized`, т.к. домен `coverartarchive.org` редиректит на archive.org) с fallback-заглушкой (градиент + иконка `Disc3`) при `onError`/отсутствии `src`. Если vgpu-обложки нравятся как fallback — можно оставить их именно как fallback.
- Неиспользуемые зависимости (`ai`, `@ai-sdk/*`, `vgpu`, если больше не нужны) — удалить.
- Жанры/плейлисты/избранное из next-beats, которые не ложатся на нашу модель: страницы удалить или временно скрыть из навигации (запиши в Журнал, что скрыто). Плейлисты — вне MVP.

### 2. Конфигурация

- `web/.env.example`: `BACKEND_URL=http://localhost:8080`, `NEXT_PUBLIC_BACKEND_URL=http://localhost:8080`.
- `lib/env.ts` — валидация через Zod (уже есть в зависимостях), экспорт `serverBackendUrl`, `publicBackendUrl`.
- `next.config.ts`: разрешить картинки с `coverartarchive.org` и `*.archive.org` (если используется `next/image`).

### 3. Типизированный API-клиент

- Dev-зависимости: `openapi-typescript`, рантайм: `openapi-fetch`.
- Скрипт `"gen:api": "openapi-typescript ./openapi.json -o ./lib/api/schema.d.ts"`; запустить, закоммитить `schema.d.ts`.
- `lib/api/client.ts`:
  ```ts
  import createClient from "openapi-fetch";
  import type { paths } from "./schema";
  // на сервере — BACKEND_URL, в браузере — NEXT_PUBLIC_BACKEND_URL
  export const api = createClient<paths>({ baseUrl: typeof window === "undefined" ? serverBackendUrl : publicBackendUrl });
  export type Schemas = components["schemas"];
  ```
- `lib/api/errors.ts` — разбор `{error:{code,message}}`, функция `unwrap(res)` бросает `ApiError`.
- Серверные функции получения данных — в `lib/data/*.ts` (`server-only`), используют `'use cache'` + `cacheTag(...)` + `cacheLife('seconds'|...)` в стиле next-beats. На этом шаге: `getHealth()`. Данные библиотеки появятся в шаге 11 — страницы библиотеки пока показывают пустое состояние «Библиотека пуста — найдите музыку через поиск».
- Соглашение по тегам кэша (используется в шагах 09–11): `library`, `artist:{id}`, `album:{id}`, `track:{id}`.

### 4. WebSocket-хук

`hooks/use-live-events.ts` + провайдер `providers/live-events-provider.tsx` (одно соединение на вкладку):
- подключение к `${NEXT_PUBLIC_BACKEND_URL.replace(/^http/, "ws")}/api/ws`;
- автопереподключение с экспоненциальной задержкой (1 с → 30 с), состояние `connecting|open|closed`;
- типы событий (вручную, т.к. WS не в OpenAPI) в `lib/api/events.ts`:
  ```ts
  export type LiveEvent =
    | { type: "track.status"; track_id: number; album_id: number; status: TrackStatus; reason: string | null }
    | { type: "job.progress"; album_id: number; stage: "searching" | "verifying"; done: number; total: number }
    | { type: "stream.progress"; track_id: number; bytes_done: number; bytes_total: number; peers: number; down_speed_bps: number }
    | { type: "library.changed"; entity: "artist" | "album" | "track"; id: number }
    | { type: "resync" };
  ```
- API: `useLiveEvent(type, handler)` — подписка на тип; `useConnectionState()`.
- Маленький индикатор соединения (точка в сайдбаре/футере) — серый/зелёный.

### 5. Тесты/проверки

- Существующие Playwright-тесты next-beats, завязанные на удалённую функциональность, — удалить или переписать на smoke: «главная открывается, навигация видна».
- `pnpm build` без `DATABASE_URL`.

### 6. justfile

```make
web-gen-api: openapi
    cd web && pnpm gen:api
```

## Критерии приёмки

- `cd web && pnpm build` проходит; в `package.json` нет Prisma и vgpu (если vgpu не оставлен как fallback — отметь).
- `grep -rn "prisma" web --include=*.ts --include=*.tsx -l` — пусто (кроме node_modules).
- При запущенном бэкенде: `pnpm dev`, главная открывается, индикатор WS зелёный; при выключенном бэкенде — серый, страница не падает.
- `just web-check` проходит.

## Вне рамок шага

UI поиска (шаг 09), страницы библиотеки с данными (шаг 11), реальный звук (шаг 19).
