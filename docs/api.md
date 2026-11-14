# API

- Схема OpenAPI — `GET /api/openapi.json` (открыта; Swagger UI не встроен — схему можно открыть в любом
  OpenAPI-просмотрщике; она же закоммичена в `web/openapi.json`; типы фронтенда генерируются `just web-gen-api`).
- Ошибки: `{ "error": { "code": "...", "message": "..." } }`.
- Авторизация (если задан `NIMBUS_API_TOKEN`): `Authorization: Bearer <token>` или cookie `nimbus_token`
  (`POST /api/auth/login {"token": "..."}` → `204` + cookie; `POST /api/auth/logout`). Без токена — `401 unauthorized`.
  `GET /api/health` открыт всегда и возвращает `db`, `engine {torrents, down_bps, up_bps}`, `jobs {queued, running, failed_24h}` и
  `providers [{ source, state: "ok"|"open", last_error, open_until }]` (`open` — предохранитель провайдера разомкнут:
  запросы к нему временно не отправляются до `open_until`).

## Очередь задач

- `GET /api/jobs?state=&kind=&limit=` → `{ jobs: [JobDto], counts: { queued, running, failed } }`;
  `JobDto { id, kind, payload, state, attempts, max_attempts, priority, run_after, last_error, updated_at }`.
  `state` — `queued|running|done|failed` (иначе `400 invalid_state`); `limit` 1–500 (по умолчанию 50);
  счётчики не зависят от фильтров.
- `POST /api/jobs/{id}/retry` — только для `failed`: попытки обнуляются, приоритет интерактивный. `404` — нет задачи,
  `409 not_failed` — задача не `failed`, `409 duplicate` — уже есть активная такая же.
- `PUT /api/settings` дополнительно возвращает `restart_required: true`, если изменился раздел `performance` (в том числе `metadata_concurrency` 1–64 и `metadata_timeout_secs` 5–300)
- Раздел `musicbrainz` (`base_url` — `http(s)://…/`, `rate_per_sec` 0 или 0.1–100, `burst` 1–20, `max_concurrent` 1–32) применяется на лету; для чужого адреса с неизменёнными остальными полями действует профиль зеркала (без лимита, 8 параллельных).
  (число воркеров применяется после перезапуска).

## Приобретение альбомов

Состояние альбома считается по его трекам из библиотеки (см. `docs/architecture.md`, «Приобретение альбомов»):
`searching` · `downloading` · `partial` · `missing` · `available` · `downloaded`.

- `GET /api/acquisition?state=&cursor=&limit=` → `{ items: [AcquisitionItem], next_cursor }`. `state` — список через
  запятую (иначе `400 invalid_state`), `cursor` — из `next_cursor` (испорченный — `400 invalid_cursor`), `limit` 1–200
  (по умолчанию 50). Порядок: сначала `searching`, затем по `last_finished_at DESC NULLS LAST`, `album_id`.
  `AcquisitionItem { album { id, title, year, cover_url, artist { id, name } }, state, tracks { total, adding, found,
  not_found, ready }, reason, search { attempts, last_finished_at, last_outcome, candidates, provider_errors
  [{ source, error }], next_retry_at }, download { bytes_done, bytes_total } | null, active_jobs }`.
  `reason` — преобладающая причина `not_found` (`search_failed` > `no_torrents` > `dead_torrents` > `no_match`).
- `GET /api/acquisition/summary` → `{ searching, missing, partial, available, downloading, downloaded, failed_jobs }`.
- `POST /api/acquisition/retry { scope: "missing" | "albums", album_ids?, reset_dead? }` → `202 { queued }`.
  `missing` — все `missing`/`partial` (не больше 5000 за вызов); `albums` требует `album_ids` (не больше 5000, иначе
  `400 too_many_albums`; несуществующие игнорируются и не входят в `queued`). `reset_dead` возвращает раздачам альбома
  с `dead|timeout|error` статус `pending` — их проверят заново. Приоритет интерактивный, счёт авто-повторов
  начинается заново. Уже проверенные раздачи заново не проверяются.
- `POST /api/albums/{id}/retry` и `POST /api/tracks/{id}/retry` работают через ту же логику (`nimbus_library::retry`).
- `PUT /api/settings` возвращает `suggest_retry_missing: true`, если появился новый включённый провайдер или
  изменились его адрес/ключ/учётные данные; тогда альбомам `missing`/`partial` назначается авто-повтор «сейчас».
  Настройка `search.auto_retry` (по умолчанию `true`) включает автоматический повтор.

## WebSocket `/api/ws`

Токен — cookie, заголовок или `?token=`. Сообщения — JSON с полем `type`:

| type | поля | когда |
|---|---|---|
| `track.status` | `track_id`, `album_id`, `status`, `reason` | изменился статус трека |
| `job.progress` | `album_id`, `stage` (`searching` \| `verifying`), `done`, `total` | прогресс поиска/проверки раздач |
| `stream.progress` | `track_id`, `bytes_done`, `bytes_total`, `peers`, `down_speed_bps` | идёт загрузка воспроизводимого файла |
| `acquisition.changed` | `album_id` | могло измениться состояние приобретения альбома (не чаще раза в 500 мс на альбом, плюс одно замыкающее) |
| `library.changed` | `entity` (`artist` \| `album` \| `track`), `id` | изменилась библиотека |
| `resync` | — | клиент отстал: нужно перечитать состояние |

Сервер шлёт ping каждые 25 с; клиент без активности 60 с отключается. Источник истины по типам —
`backend/crates/core/src/events.rs`, на фронтенде — `web/lib/api/events.ts`.
