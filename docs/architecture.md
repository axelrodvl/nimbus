# Архитектура

```
Браузер (Next.js) ──REST──► Rust API (axum) ──► PostgreSQL
   │   ▲                      │   │
   │   └──── WebSocket ───────┘   ├──► MusicBrainz API / Cover Art Archive
   │                              ├──► Провайдеры: TPB (apibay), RuTracker, Torznab
   └── <audio src=/api/.../stream> ┴──► librqbit (торрент-движок) ──► диск (кэш)
```

В Docker перед веб-частью и API стоит Caddy (единый origin: `/` → web, `/api` → backend, без буферизации стрима).
Сервер Next.js ходит в API с `BACKEND_URL`; браузер — на тот же origin (`NEXT_PUBLIC_BACKEND_URL` пуст).

## Крейты бэкенда

`core` (модели, конфиг, события, настройки) · `db` (миграции, репозитории) · `musicbrainz` · `trackers` (провайдеры) ·
`matcher` (файлы ↔ треки, CUE) · `torrent` (обёртка над librqbit) · `library` (добавление в библиотеку) ·
`worker` (очередь задач и обработчики) · `api` (axum, OpenAPI, стриминг).

## Жизненный цикл трека

```
 добавлен ──► [adding] ──(файл сопоставлен)──► [found] ──(файл полностью скачан)──► [ready]
                 │
                 └──(кандидаты исчерпаны)──► [not_found] ──(retry / свой magnet)──► [adding]
```

- `adding` — идёт поиск раздач / верификация (прогресс — событие `job.progress`).
- `found` — в какой-то раздаче найден файл, трек можно стримить.
- `not_found` — причина в `status_reason`: `no_torrents`, `dead_torrents`, `no_match`.
- `ready` — файл целиком в локальном кэше (вытеснение кэша возвращает `ready → found`).

## Конвейер

1. **Поиск** — `/api/search` → MusicBrainz (лимит 1 req/s, кэш в БД).
2. **Добавление** — `POST /api/library` → артист/альбом/треки (`adding`) → задача `discover_album` / `discover_artist`.
3. **Discover** — провайдеры ищут раздачи → ранжирование → `torrents` + `album_torrents` → задачи `verify_torrent`.
4. **Verify** — librqbit получает список файлов по magnet (без скачивания) → matcher → `track_sources` → `found` / `not_found`.
   CUE-образы разбирает `process_cue`.
5. **Play** — `GET /api/tracks/{id}/stream`: качается только нужный файл, куски в приоритете от текущей позиции, ответ `206`.
   По завершении — `ready`. Для CUE/экзотических форматов — перекодирование ffmpeg в FLAC.
6. **Кэш** — задача `evict_cache` по лимиту (`NIMBUS_CACHE_LIMIT_GB` / настройки), не трогает активные стримы и prefetch.

## Очередь задач и события

Задачи лежат в таблице `jobs` (`LISTEN/NOTIFY` + опрос, повторы с backoff). События публикуются в `EventBus` и
транслируются клиентам через `/api/ws`.

## Авторизация

Один статический токен (`NIMBUS_API_TOKEN`), сравнение за постоянное время. Источники: `Authorization: Bearer`,
cookie `nimbus_token` (HttpOnly, SameSite=Lax; значение — hex токена), для WebSocket также `?token=`.
`/api/health` и `/api/auth/login` открыты. Внутренний `/api/internal/raw/…` доступен только с loopback (для ffmpeg).
Веб-сервер (`proxy.ts`) перенаправляет на `/login` без валидной cookie и ходит в API с токеном из своего окружения.
