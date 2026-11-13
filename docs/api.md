# API

- Схема OpenAPI — `GET /api/openapi.json` (открыта; Swagger UI не встроен — схему можно открыть в любом
  OpenAPI-просмотрщике; она же закоммичена в `web/openapi.json`; типы фронтенда генерируются `just web-gen-api`).
- Ошибки: `{ "error": { "code": "...", "message": "..." } }`.
- Авторизация (если задан `NIMBUS_API_TOKEN`): `Authorization: Bearer <token>` или cookie `nimbus_token`
  (`POST /api/auth/login {"token": "..."}` → `204` + cookie; `POST /api/auth/logout`). Без токена — `401 unauthorized`.
  `GET /api/health` открыт всегда и возвращает `db`, `engine {torrents, down_bps, up_bps}` и `jobs {queued, running, failed_24h}`.

## Очередь задач

- `GET /api/jobs?state=&kind=&limit=` → `{ jobs: [JobDto], counts: { queued, running, failed } }`;
  `JobDto { id, kind, payload, state, attempts, max_attempts, priority, run_after, last_error, updated_at }`.
  `state` — `queued|running|done|failed` (иначе `400 invalid_state`); `limit` 1–500 (по умолчанию 50);
  счётчики не зависят от фильтров.
- `POST /api/jobs/{id}/retry` — только для `failed`: попытки обнуляются, приоритет интерактивный. `404` — нет задачи,
  `409 not_failed` — задача не `failed`, `409 duplicate` — уже есть активная такая же.
- `PUT /api/settings` дополнительно возвращает `restart_required: true`, если изменился раздел `performance` (в том числе `metadata_concurrency` 1–64 и `metadata_timeout_secs` 5–300)
  (число воркеров применяется после перезапуска).

## WebSocket `/api/ws`

Токен — cookie, заголовок или `?token=`. Сообщения — JSON с полем `type`:

| type | поля | когда |
|---|---|---|
| `track.status` | `track_id`, `album_id`, `status`, `reason` | изменился статус трека |
| `job.progress` | `album_id`, `stage` (`searching` \| `verifying`), `done`, `total` | прогресс поиска/проверки раздач |
| `stream.progress` | `track_id`, `bytes_done`, `bytes_total`, `peers`, `down_speed_bps` | идёт загрузка воспроизводимого файла |
| `library.changed` | `entity` (`artist` \| `album` \| `track`), `id` | изменилась библиотека |
| `resync` | — | клиент отстал: нужно перечитать состояние |

Сервер шлёт ping каждые 25 с; клиент без активности 60 с отключается. Источник истины по типам —
`backend/crates/core/src/events.rs`, на фронтенде — `web/lib/api/events.ts`.
