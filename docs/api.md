# API

- Схема OpenAPI — `GET /api/openapi.json` (открыта; Swagger UI не встроен — схему можно открыть в любом
  OpenAPI-просмотрщике; она же закоммичена в `web/openapi.json`; типы фронтенда генерируются `just web-gen-api`).
- Ошибки: `{ "error": { "code": "...", "message": "..." } }`.
- Авторизация (если задан `NIMBUS_API_TOKEN`): `Authorization: Bearer <token>` или cookie `nimbus_token`
  (`POST /api/auth/login {"token": "..."}` → `204` + cookie; `POST /api/auth/logout`). Без токена — `401 unauthorized`.
  `GET /api/health` открыт всегда и возвращает `db`, `engine {torrents, down_bps, up_bps}` и `jobs {queued, running, failed_24h}`.

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
