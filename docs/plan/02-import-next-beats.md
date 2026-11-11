# Шаг 02 — Импорт next-beats и инвентаризация

**Зависит от:** 01
**Оценка:** 0.5–1 день

## Цель

Положить исходники [nextjs/next-beats](https://github.com/nextjs/next-beats) в `web/`, убедиться, что приложение собирается и запускается **как есть**, и составить `docs/web-inventory.md` — карту компонентов и мест, которые будут меняться в шагах 08, 09, 11, 19. Последующие фронтенд-шаги опираются на этот документ, поэтому он должен быть конкретным (пути файлов, имена компонентов, что они делают).

## Контекст о next-beats (из README/package.json)

- Next.js 16 (canary), App Router, Cache Components, Server Functions, React 19 + React Compiler.
- Tailwind v4, `lucide-react`, `next-themes`, `sonner`, `geist`, Zod 4.
- Prisma 7 + PostgreSQL (`@prisma/adapter-pg`), сид `prisma/seed.ts`.
- Звук **синтезируется** через Web Audio API (процедурно по жанру) — его мы позже заменим на реальный стрим.
- Обложки — WebGPU-шейдеры (`vgpu`), скрипт `scripts/generate-covers.mts`.
- Каталоги: `app/ components/ features/ hooks/ lib/ prisma/ providers/ public/ scripts/ tests/ types/`, корневые `proxy.ts`, `next.config.ts`, `prisma.config.ts`.
- Тесты: Playwright (`@next/playwright`).

## Что сделать

1. Скачать исходники без истории в `web/`:
   ```bash
   git clone --depth 1 https://github.com/nextjs/next-beats /tmp/next-beats
   rm -rf /tmp/next-beats/.git
   rm -f web/.gitkeep && cp -r /tmp/next-beats/. web/
   ```
   Сохранить файл `LICENSE` (MIT) и добавить в `web/README.md` строку «Fork of nextjs/next-beats (MIT)».
2. Удалить из `web/` то, что не нужно в монорепо: `.github/` (CI сделаем свой), Vercel-специфичные конфиги, если мешают локальному запуску. `.agents/skills/` можно оставить.
3. Установить зависимости: `cd web && pnpm install`. Если `pnpm` нет — `corepack enable`.
4. Запустить как есть, чтобы понять приложение: использовать Postgres из шага 01 (создать отдельную БД `nextbeats_tmp`, чтобы не мешать бэкенду):
   ```bash
   docker compose exec -T db psql -U nimbus -c 'create database nextbeats_tmp'
   # в web/.env.local: DATABASE_URL=postgres://nimbus:nimbus@localhost:5432/nextbeats_tmp
   pnpm prisma migrate deploy   # или db push — смотри README next-beats
   pnpm run prisma.seed
   pnpm dev
   ```
   Открыть `http://localhost:3000`, пройтись по страницам. Если есть Playwright/Chromium — снять скриншоты основных страниц в `docs/screenshots/` (deviceScaleFactor 1) для справки.
5. Составить **`docs/web-inventory.md`** со следующими разделами:
   - **Маршруты** (`app/**/page.tsx`, `layout.tsx`): URL → файл → что показывает → откуда берёт данные (какие функции из `lib/` / Prisma-запросы).
   - **Слой данных**: все места, где используется Prisma (`lib/db.ts` и т.д.), список функций-запросов и Server Functions (мутаций) с сигнатурами. Какие `cacheTag`/`cacheLife` используются.
   - **Аудио**: где живёт синтез Web Audio, провайдер плеера, его состояние и API (play/pause/next/queue), какие компоненты его используют. Это будет заменено в шаге 19 — опиши интерфейс подробно.
   - **Ключевые UI-компоненты**: список треков (строка трека), карточка альбома/плейлиста, плеер-бар, сайдбар/навигация, поиск (если есть), избранное/плейлисты. Для каждого — путь, пропсы, где используется.
   - **Модель данных Prisma**: модели и поля (кратко), и маппинг на нашу модель (Artist/Album/Track из шага 04) — что ложится 1:1, что выкидываем (жанры? процедурные параметры?), что добавляем (status).
   - **Обложки**: как генерируются, как подменить на URL из Cover Art Archive.
   - **Что удалить в шаге 08**: конкретный список файлов/зависимостей (Prisma, seed, синтез, vgpu-обложки, `ai`-пакеты, если не используются).
   - **Риски**: canary-зависимости, React Compiler, всё, что ломается при сборке.
6. В корневой `justfile` добавить:
   ```make
   web:
       cd web && pnpm dev
   web-build:
       cd web && pnpm build
   web-check:
       cd web && pnpm lint && pnpm exec tsc --noEmit
   ```
7. Удалить временную БД `nextbeats_tmp` не обязательно, но `web/.env.local` не коммитить.

## Критерии приёмки

- `cd web && pnpm install && pnpm build` проходит (сборка исходного next-beats, ещё с Prisma). Если сборка требует `DATABASE_URL` — задокументируй это в инвентаризации.
- `pnpm dev` открывает приложение, главная страница отдаёт 200 (`curl -sI localhost:3000 | head -1`).
- `docs/web-inventory.md` существует, содержит все разделы выше с реальными путями файлов.

## Вне рамок шага

Любые изменения функциональности фронтенда — только импорт и документация.
