# Шаг 01 — Монорепо и инфраструктура

**Зависит от:** —
**Оценка:** 0.5 дня

## Цель

Инициализировать git-репозиторий, структуру каталогов, Postgres в docker compose, `.env.example`, `justfile`, `.gitignore`. После шага любой следующий шаг может поднять БД одной командой.

## Контекст

В корне уже лежат `PLAN.md`, `CLAUDE.md`, `docs/plan/*.md`. Больше ничего нет.

## Что сделать

1. `git init -b main` в корне (если ещё не репозиторий).
2. Создать каталоги: `backend/`, `web/` (пустые с `.gitkeep`, их наполнят шаги 02 и 03), `data/` (в `.gitignore`).
3. `.gitignore`:
   ```
   /data/
   .env
   .env.local
   **/target/
   **/node_modules/
   web/.next/
   *.log
   .DS_Store
   ```
4. `docker-compose.yml` (на этом шаге — только БД; сервисы backend/web добавит шаг 23):
   ```yaml
   services:
     db:
       image: postgres:17
       environment:
         POSTGRES_USER: nimbus
         POSTGRES_PASSWORD: nimbus
         POSTGRES_DB: nimbus
       ports:
         - "${POSTGRES_PORT:-5432}:5432"
       volumes:
         - pgdata:/var/lib/postgresql/data
       healthcheck:
         test: ["CMD-SHELL", "pg_isready -U nimbus"]
         interval: 2s
         timeout: 3s
         retries: 30
   volumes:
     pgdata:
   ```
5. `.env.example` — все переменные из таблицы «Порты и переменные окружения» в `PLAN.md` с дефолтами и комментариями. Скопировать в `.env` локально (не коммитить).
6. `justfile` (используем [just](https://github.com/casey/just); если не установлен — `cargo install just` или пакет ОС, и упомяни это в README):
   ```make
   set dotenv-load := true

   default:
       @just --list

   db-up:
       docker compose up -d db
       docker compose exec -T db sh -c 'until pg_isready -U nimbus; do sleep 1; done'

   db-down:
       docker compose down

   db-reset:
       docker compose down -v
       just db-up

   psql:
       docker compose exec db psql -U nimbus nimbus
   ```
   Рецепты `backend`, `web`, `test`, `check` добавят шаги 02/03 — оставь заготовки с `@echo "not yet"`.
7. `README.md` — короткий: что за проект, ссылка на `PLAN.md`, требования (Docker, Rust stable, Node 22+, pnpm, just, ffmpeg — для шага 21), быстрый старт (`cp .env.example .env && just db-up`).
8. Если Docker недоступен в окружении: опиши в README альтернативу — локальный PostgreSQL 15+ с пользователем/БД `nimbus/nimbus` — и проверь подключение через `psql "$DATABASE_URL" -c 'select 1'`.

## Критерии приёмки

- `just db-up` поднимает Postgres, `psql "postgres://nimbus:nimbus@localhost:5432/nimbus" -c 'select 1'` возвращает `1` (или локальный Postgres при отсутствии Docker — отметь в Журнале).
- `git status` чистый после коммита; `.env` не в индексе.
- В репозитории есть `PLAN.md`, `CLAUDE.md`, `docs/plan/`, `README.md`, `docker-compose.yml`, `.env.example`, `justfile`, `.gitignore`.

## Вне рамок шага

Код бэкенда и фронтенда.
