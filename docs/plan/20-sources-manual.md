# Шаг 20 — Источники: ручной выбор, свой magnet, retry

**Зависит от:** 18, 19
**Оценка:** 1.5 дня

## Цель

Дать пользователю контроль, когда автоматика ошиблась: посмотреть раздачи альбома и источники трека, выбрать другой файл/раздачу, подтвердить сомнительное совпадение, добавить свой magnet, перезапустить поиск.

## Что сделать

### 1. Бэкенд — эндпоинты (все в OpenAPI)

```
GET  /api/albums/{id}/torrents
     → [{ torrent: TorrentDto, rank_score, verified, matched_tracks: i64, files_count: i64 }]
GET  /api/torrents/{id}/files
     → [{ file_index, path, size_bytes, ext, matched_track_id: Option<i64> }]
GET  /api/tracks/{id}/sources
     → [{ id, torrent: TorrentDto, file_index, path, size_bytes, match_score, is_primary, needs_confirmation }]
PUT  /api/tracks/{id}/source       body: { source_id } | { torrent_id, file_index }
     → устанавливает primary (если пары нет в track_sources — создаёт с match_score = 1.0, needs_confirmation=false);
       трек → found (если был not_found/adding), либо ready, если этот файл уже скачан
POST /api/tracks/{id}/sources/{source_id}/confirm   → needs_confirmation = false
POST /api/tracks/{id}/retry        → трек → adding, Job::DiscoverAlbum (dedup)
POST /api/albums/{id}/retry        → все не-found/не-ready треки → adding, сбросить album_torrents.verified для
                                     раздач с meta_status timeout (дать шанс ещё раз), DiscoverAlbum
POST /api/albums/{id}/torrents     body: { magnet }
     → валидировать magnet (InfoHash::from_magnet), torrents::upsert (source = manual, title из dn= или hash),
       album_torrents::link(rank_score = 1.0), Job::VerifyTorrent; 202
```
`TorrentDto { id, info_hash, source, title, size_bytes, seeders, leechers, kind, meta_status }`.

При смене primary: если старый файл качается и больше никому не нужен — `engine.release_file(.., delete_data=false)` (данные удалит вытеснение кэша в шаге 22).

Публиковать `track.status` и `library.changed` где уместно.

### 2. Фронтенд

- **Страница/вкладка «Источники» альбома** (`/album/[id]/sources` или вкладка на странице альбома): таблица раздач — источник (иконка TPB/RuTracker/Torznab/manual), название, тип, размер, сиды/личи, статус метаданных, сколько треков найдено; раскрывающийся список файлов (`GET /api/torrents/{id}/files`) с пометкой сопоставленных треков. Кнопка «Повторить поиск» и форма «Добавить magnet».
- **Диалог «Источник трека»** из контекстного меню строки трека (`…` → «Выбрать источник»): список `sources` (primary выделен, `needs_confirmation` — с пометкой «проверьте» и кнопкой «Подтвердить»), кнопка «Выбрать файл вручную» → выбор раздачи альбома → выбор файла из дерева.
- В строке трека и в шапке альбома: значок предупреждения, если primary-источник `needs_confirmation`.
- Для `not_found`: в tooltip/строке — кнопка «Повторить» и «Указать вручную».
- Все мутации — Server Functions + `updateTag(album:{id})`.

## Тесты

- Бэкенд (`#[sqlx::test]`): `PUT source` по паре без записи создаёт источник и делает primary, трек `not_found → found`; `confirm`; `retry` ставит задачу и меняет статус; ручной magnet → `torrents.source='manual'` + verify-задача; невалидный magnet → `400`.
- Фронтенд (Playwright с моками): выбор другого файла в диалоге отправляет `PUT` с правильным телом и обновляет статус в строке.

## Критерии приёмки

- `just test`, `just check`, `pnpm build`, Playwright проходят; `web/openapi.json` и `schema.d.ts` обновлены.

## Вне рамок шага

CUE (шаг 21), настройки (шаг 22).
