# API

- Схема OpenAPI — `GET /api/openapi.json` (открыта; Swagger UI не встроен — схему можно открыть в любом
  OpenAPI-просмотрщике; она же закоммичена в `client/openapi.json` (`just openapi`); типы клиента генерируются `just client-gen-api`).
- Ошибки: `{ "error": { "code": "...", "message": "...", "field": "musicbrainz.burst" } }`; `field` (путь поля запроса) есть только у ошибок валидации настроек `invalid_settings`, когда сообщение начинается с пути поля.
- Авторизация (если задан `NIMBUS_API_TOKEN`): `Authorization: Bearer <token>` или cookie `nimbus_token`
  (`POST /api/auth/login {"token": "..."}` → `204` + cookie; `POST /api/auth/logout`). Без токена — `401 unauthorized`.
  `GET /api/health` открыт всегда и возвращает `db`, `engine {torrents, down_bps, up_bps}`, `jobs {queued, running, failed_24h}`, `workers {restarts, worker_restarts, maintenance_restarts, listener_restarts}` (сколько раз циклы воркеров очереди перезапускались после паники; ненулевое значение — повод смотреть логи) и
  `providers [{ source, state: "ok"|"open", last_error, open_until }]` (`open` — предохранитель провайдера разомкнут:
  запросы к нему временно не отправляются до `open_until`).

- Один origin: бэкенд раздаёт и API, и собранный SPA (`NIMBUS_WEB_DIR`); токен защищает только `/api/*`, статика открыта.
  Неизвестный путь под `/api/` — JSON `404 not_found`, а не `index.html`.
- Постраничные списки `/api/library/*` оставлены для сторонних клиентов; **основной способ получить библиотеку — синхронизация**
  (`/api/sync/*`, ниже): так работает собственный клиент.

## Очередь задач

- `GET /api/jobs?state=&kind=&limit=` → `{ jobs: [JobDto], counts: { queued, running, failed } }`;
  `JobDto { id, kind, payload, state, attempts, max_attempts, priority, run_after, last_error, fatal, updated_at }`
  (`fatal` — окончательный провал: автоматически не оживёт, только ручной повтор).
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

- `GET /api/acquisition?state=&album_ids=&cursor=&limit=` → `{ items: [AcquisitionItem], next_cursor }`. `state` — список через
  запятую (иначе `400 invalid_state`), `album_ids` — только эти альбомы, id через запятую, не больше 100
  (иначе `400 invalid_album_ids`; шаг 44: клиент так узнаёт состояние одного альбома), `cursor` — из `next_cursor` (испорченный — `400 invalid_cursor`), `limit` 1–200
  (по умолчанию 50). Порядок: сначала `searching`, затем по `last_finished_at DESC NULLS LAST`, `album_id`.
  `AcquisitionItem { album { id, title, year, cover_url, artist { id, name } }, state, tracks { total, adding, found,
  not_found, ready }, reason, search { attempts, last_finished_at, last_outcome, candidates, provider_errors
  [{ source, error }], next_retry_at }, download { bytes_done, bytes_total, pinned, state, down_bps, peers, error } | null,
  active_jobs }`. `download` есть, если у альбома идёт загрузка или есть закрепления: `pinned` — есть закреплённые треки,
  `state` — агрегат закреплений (`downloading` > `queued` > `failed` > `waiting_source` > `done`, `null` — не закреплён),
  `down_bps`/`peers` — живая статистика менеджера загрузок (0, если не качается), `error` — причина `failed`
  (например `stalled`).
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

## Загрузки на сервер (закрепление)

Закрепление (pin) — явная команда «скачать трек/альбом на сервер и не вытеснять из кэша» (шаг 33; см.
`docs/architecture.md`, «Загрузки на сервер»). Закрепление привязано к треку; состояния: `queued`, `downloading`,
`done`, `waiting_source` (источник ещё не найден), `failed`.

- `POST /api/albums/{id}/download` → `200 { pinned }`: закрепляет все треки альбома из библиотеки; идемпотентно
  (повторный вызов возвращает `failed`-закрепления в очередь). `404` — нет альбома.
- `DELETE /api/albums/{id}/download?delete_files=true|false` → `204`: снимает закрепление. Недокачанные файлы
  отменяются вместе с частичными данными; скачанные остаются (их снова может вытеснить кэш) или, при
  `delete_files=true`, удаляются с диска и из движка (кроме файла, нужного другому закреплённому треку или играющего
  сейчас; треки `ready → found`). `404` — нет альбома.
- `POST /api/tracks/{id}/download` → `200 { pinned: 1 }`; `404` — нет трека, `409 not_in_library` — трека нет в
  библиотеке. `DELETE /api/tracks/{id}/download?delete_files=` → `204`, `404` — нет трека.
- `POST /api/downloads/pause-all` / `resume-all` → `200 { paused }`. Пауза — глобальный флаг (переживает рестарт): новые
  закреплённые загрузки не стартуют, торренты, которые качаются только ради закреплений, ставятся на паузу (торрент со
  стримящимся файлом не трогается).
- `GET /api/downloads` дополнен полями `paused` и `queue { queued, downloading, waiting_source, failed }`.
- `GET /api/storage` дополнен: `pinned_bytes`, `pinned_files`, `over_limit` (закреплённое одно превышает лимит кэша).
- Настройки: `performance.download_concurrency` (1–32, по умолчанию 4; торрентов одновременно),
  `storage.auto_download` (`off` | `added`, по умолчанию `off`; при `added` всё добавляемое в библиотеку закрепляется).

## Синхронизация

Шаг 34. Клиент держит всю библиотеку у себя; ему нужны «дай всё» и «дай изменённое с курсора X». Все ответы
`/api/sync/*` сжимаются (gzip, br — только они, аудиостримы не сжимаются) и требуют токена.

- `GET /api/sync/snapshot` — `application/x-ndjson`, по JSON-объекту в строке: `{"type":"begin","cursor":"…","schema":1}`,
  затем `artist`, `album`, `track`, `playlist`, `playlist_track` (`{"type":…,"row":{…}}`, именно в этом порядке сущностей),
  в конце `{"type":"end","counts":{artists,albums,tracks,playlists,playlist_tracks}}`. Снимок принят, только если получена
  строка `end`; ошибка БД посреди потока обрывает тело ответа без `end`. Синхронизируются **все** строки этих таблиц
  (страница артиста показывает всю дискографию, не только библиотеку). Строки нормализованы: у трека нет имён альбома и
  артиста, а `playback` (`direct` | `transcode`) и `needs_confirmation` считаются тем же SQL-выражением, что в старом API.
- `GET /api/sync/changes?cursor=` → `{ cursor, reset, artists, albums, tracks, playlists, playlist_tracks, deleted: [{entity, id}], more }`.
  Не больше 5000 строк (с надгробиями) по возрастанию `(sync_txid, сущность, id)`; `more: true` — запросите ещё с
  возвращённым `cursor`. `reset: true` (остальное пусто, `cursor` пуст) — курсор не разбирается, чужой `schema`/`epoch`,
  ниже `floor` (надгробия вычищены) или выше текущей транзакции (база откатилась): берите снимок заново. Без `cursor` —
  `400 invalid_cursor`. Живая строка и её надгробие в одном ответе не встречаются. Строки могут повторяться — клиент
  делает upsert.
- `GET /api/auth/session` (публичный) → `{ auth_required, authenticated }`: `authenticated` истинно, если авторизация
  выключена или предъявлен верный токен (cookie / Bearer).
- WebSocket: событие `sync.poke` — «в синхронизируемых таблицах что-то изменилось, запросите дельту».

**Модель согласованности.** Каждую синхронизируемую строку последней записала транзакция `sync_txid`
(`txid_current()`, ставит триггер; миграция `0012_sync.sql`). Ответ формируется в одной транзакции `REPEATABLE READ READ ONLY`,
а курсор — `xmin` её снимка: номер самой старой ещё не завершённой транзакции. Транзакция, не видимая этому ответу, имела
номер `>= xmin`, поэтому дельта «все строки с `sync_txid >= курсор`» **не пропускает** изменения параллельных
транзакций воркеров, но может повторить уже известные. Долгая чужая транзакция (`pg_dump`) удерживает `xmin`:
дельты повторяют одни и те же строки, пока она открыта, — это корректно. Удаления — таблица `sync_tombstones`
(триггеры `AFTER DELETE`, в том числе каскадные); надгробия старше 30 дней чистит `maintenance_loop` раз в сутки и поднимает
`floor` (`settings.sync`), после чего старые курсоры получают `reset`. Производные поля трека (`needs_confirmation`,
`playback`, счётчик прослушиваний) живут в `track_sources` и `track_plays`: их изменения «касаются» треков триггерами
уровня оператора.

**Курсор** — непрозрачная строка. Формат: `<schema>.<epoch>.<xmin>` (`schema` — версия формата, `epoch` — случайный
идентификатор базы) или, посреди постраничной выдачи, `<schema>.<epoch>.<xmin>.<txid>.<rank>.<id>`. Хвост нужен потому,
что тысячи строк одной транзакции (массовый импорт) имеют один `sync_txid` и курсор «по txid последней строки» не
продвигался бы; `xmin` в таком курсоре — снимок **первой** страницы серии, он и становится итоговым курсором: строка,
закоммиченная между страницами, но с номером не выше позиции, не попала бы на страницы, зато имеет номер `>= xmin`
первого снимка.

Настройки `playback` (`transcode_alac`, `transcode_lossy_codec`) на `playback` трека не влияют: режим определяется только
primary-источником (CUE или формат файла), поэтому `PUT /api/settings` треки не «касается».

## Библиотека, поиск, воспроизведение

Полные схемы — в OpenAPI; здесь — назначение. Собственный клиент читает библиотеку через синхронизацию
(`/api/sync/*`), остальное — действия и данные, которых в снимке нет.

**Библиотека.**
- `POST /api/library` `{ type: artist|album|track, mbid, album_mbid? }` — добавить: `201` альбом/трек добавлен, `202` артист
  добавлен и его дискография импортируется в фоне, `200` уже есть, `404 mb_not_found`, `422 recording_not_in_release`,
  `503 mb_unavailable`.
- `DELETE /api/library/{type}/{id}` → `204`: убрать из библиотеки (метаданные сохраняются; `400` — неверный `type`).
- `GET /api/library/artists`, `GET /api/library/albums`, `GET /api/library/tracks` и `GET /api/library/albums/recently-played` — постраничные списки с курсором
  (`limit` ≤ 200, испорченный курсор — `400`); для сторонних клиентов.
- `GET /api/artists/{id}`, `GET /api/albums/{id}`, `GET /api/tracks/{id}` — карточки с вложенными данными (`404`).
- `POST /api/artists/{id}/import` → `202`: повторить импорт дискографии артиста (после ошибки MusicBrainz).
- `GET /api/artist-image/{mbid}` → `200` картинка артиста (`404 no_image`, если нет; `502 image_unavailable` — источник недоступен).
- `GET /api/covers/{kind}/{mbid}/{size}` → `200` обложка Cover Art Archive (`kind` — `release-group`/`release`, `size` — 250 или 500; `404 no_image`).
  Обе ручки скачивают картинку один раз, хранят в `{NIMBUS_DATA_DIR}/images/` и отдают с `Cache-Control: public, max-age=31536000, immutable`
  (отсутствие картинки запоминается на сутки).

**Поиск.** `GET /api/search?q=&types=&limit=` — MusicBrainz (кэш в БД): `q` 1–200 символов, `types` через запятую (`artist,album,track`,
по умолчанию все), `limit` 1–25 (по умолчанию 8); `400` — пустой или слишком длинный запрос.

**Воспроизведение.**
- `GET /api/tracks/{id}/stream` — аудио: Range (`206`, `416`), условные запросы (`304`), перекодирование CUE/APE/WV/DSD
  `409` — у трека нет источника, `503` — нет движка, `504` — пиры не ответили
  за таймаут, `507` — нет места.
- `POST /api/tracks/{id}/prefetch` → `202`: подогреть начало файла следующего трека.
- `GET /api/tracks/{id}/audio-info` — кодек, частота, глубина, битрейт (`409`, пока файл не прочитан).
- `POST /api/tracks/{id}/played` — засчитать прослушивание (плеер зовёт, когда прослушана заметная часть).

**Источники.**
- `GET /api/tracks/{id}/sources` — кандидаты (раздачи с файлом трека); `PUT /api/tracks/{id}/source` `{ source_id }` или `{ torrent_id, file_index }` — выбрать основной;
  `POST /api/tracks/{id}/sources/{source_id}/confirm` — подтвердить сомнительное совпадение.
- `GET /api/albums/{id}/torrents` — раздачи альбома со статусами; `POST /api/albums/{id}/torrents` `{ magnet }` → `202`: свой magnet;
  `GET /api/torrents/{id}/files` — файлы раздачи и их сопоставление трекам.

**Плейлисты.** `GET|POST /api/playlists`, `GET|DELETE /api/playlists/{id}`, `POST /api/playlists/{id}/tracks`,
`DELETE /api/playlists/{id}/tracks/{track_id}` (`409` — плейлист изменён параллельно, перечитайте).

**Загрузки торрентов.** `POST /api/downloads/{info_hash}/pause` и `POST /api/downloads/{info_hash}/resume` → `204` (`404` — нет торрента);
`POST /api/downloads/resume-all` → `200` (парный к `pause-all`, см. «Загрузки на сервер»).

**Настройки.** `POST /api/settings/providers/test` — проверка провайдера с текущими параметрами; `POST /api/settings/reimport-artists` —
поставить на повторный импорт дискографии всех артистов библиотеки (уже имеющиеся альбомы не дублируются).

**Отладка** (только `NIMBUS_DEBUG=true`): `GET /api/debug/jobs`, `GET /api/debug/albums/{id}/torrents`,
`POST /api/debug/torrent/metadata` `{ magnet }` → список файлов без добавления (`504` — метаданные не пришли).

## WebSocket `/api/ws`

Токен — cookie, заголовок или `?token=`. Сообщения — JSON с полем `type`:

| type | поля | когда |
|---|---|---|
| `track.status` | `track_id`, `album_id`, `status`, `reason` | изменился статус трека |
| `job.progress` | `album_id`, `stage` (`searching` \| `verifying`), `done`, `total` | прогресс поиска/проверки раздач |
| `stream.progress` | `track_id`, `bytes_done`, `bytes_total`, `peers`, `down_speed_bps` | идёт загрузка воспроизводимого файла |
| `acquisition.changed` | `album_id` | могло измениться состояние приобретения альбома (не чаще раза в 500 мс на альбом, плюс одно замыкающее) |
| `download.progress` | `album_id`, `bytes_done`, `bytes_total`, `down_bps`, `peers` | раз в секунду на альбом с идущими закреплёнными загрузками (агрегат по файлам; скорость и пиры — по торрентам) |
| `library.changed` | `entity` (`artist` \| `album` \| `track`), `id` | изменилась библиотека |
| `sync.poke` | — | изменились синхронизируемые таблицы (не чаще раза в 300 мс, первое сразу): запросите `GET /api/sync/changes` |
| `resync` | — | клиент отстал: нужно перечитать состояние |

Сервер шлёт ping каждые 25 с; клиент без активности 60 с отключается. Источник истины по типам —
`backend/crates/core/src/events.rs`, на фронтенде — `client/src/lib/live/`.
