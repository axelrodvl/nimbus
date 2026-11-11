# Nimbus

Веб-плеер: метаданные из MusicBrainz, музыка — потоково из торрентов.
Фронтенд — Next.js (`web/`), бэкенд — Rust (`backend/`), БД — PostgreSQL.

План разработки: [PLAN.md](PLAN.md).

## Требования

- Docker (или локальный PostgreSQL 15+)
- Rust stable
- Node 22+ и pnpm
- [just](https://github.com/casey/just) (`cargo install just` или пакет ОС)
- ffmpeg (для шага 21)

## Быстрый старт

```sh
cp .env.example .env
just db-up
```

## Без Docker

Установите локальный PostgreSQL 15+, создайте пользователя и БД `nimbus` / `nimbus` и проверьте подключение:

```sh
psql "$DATABASE_URL" -c 'select 1'
```
