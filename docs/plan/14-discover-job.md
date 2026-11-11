# Шаг 14 — Задача поиска раздач (discover)

**Зависит от:** 10, 12
**Оценка:** 1.5 дня

## Цель

Реальные обработчики `DiscoverAlbum` и `DiscoverArtist`: собрать запросы, опросить провайдеры, отранжировать кандидатов, сохранить их в `torrents` + `album_torrents` и поставить задачи `VerifyTorrent` для лучших. Если раздач нет совсем — треки → `not_found` (`no_torrents`).

## Что сделать

### 1. `JobCtx` получает `providers: Arc<ProviderRegistry>` (и `mb` при необходимости).

### 2. Ранжирование (`trackers::rank` — чистые функции, покрыть тестами)

```rust
pub struct RankInput<'a> { pub artist: &'a str, pub album: &'a str, pub year: Option<i32> }
pub fn classify(title: &str, artist: &str, album: &str) -> TorrentKind;   // album | discography | single | unknown
pub fn score(c: &TorrentCandidate, input: &RankInput, prefs: &FormatPrefs) -> f32;  // 0..1, <0 = отбросить
```

Нормализация для сравнения: нижний регистр, `deunicode`, убрать пунктуацию, схлопнуть пробелы.

Балл (веса — константы в одном месте):
- **Артист** в названии раздачи (token set similarity ≥ 0.85) — обязательное условие, иначе `-1`.
- **Альбом** в названии: +0.35 × similarity; для `discography` альбом не требуется.
- **Тип**: `album` +0.15; `discography` +0.05 (большая, метаданные дольше); `single` −0.1 (если ищем альбом).
- **Сиды**: +0.25 × `min(1, ln(1+seeders)/ln(51))`; `seeders == 0` → `-1`; `None` — +0.05.
- **Формат** (по названию: `FLAC`, `ALAC`, `APE`, `WV`, `MP3`, `320`, `V0`, `AAC`, `24bit`, `Hi-Res`): по `FormatPrefs` (по умолчанию `flac > alac > mp3_320 > mp3_v0 > aac > ape/wv > mp3_other`) до +0.15.
- **Год** совпадает: +0.05.
- **Мусор**: `karaoke`, `tribute`, `cover`, `minus`, `минусовк`, `remix` (если не ищем ремикс), `live` (если альбом не live), `bootleg` → −0.3.
- **Размер**: альбом < 20 МБ или дискография > 200 ГБ → −0.2.

`classify`: `discography|дискография|collection|complete|anthology|\d{4}\s*-\s*\d{4}` → discography; иначе если содержит название альбома → album; `single` по ключевому слову.

### 3. `DiscoverAlbum { album_id }`

1. Загрузить альбом и артиста. Если у альбома нет треков, которые `in_library` и в статусе `adding` → завершить (нечего искать).
2. `build_queries(artist, album, year)` — запросы 1–3 из шага 12 (дискографию тоже ищем: часто альбом есть только в ней).
3. Для каждого запроса — `providers.search_all`; публиковать `JobProgress { stage: Searching, done, total }`.
4. Объединить кандидатов по `info_hash` (если известен) / `(source, topic_id)`; посчитать `score`, отбросить `< 0`, отсортировать.
5. Взять топ-N (`N = 8`, константа) и для каждого: `provider.resolve()` (если нет hash) → `torrents::upsert_by_info_hash` (`kind` из `classify`) → `album_torrents::link(album_id, torrent_id, query, score)`.
6. Если провайдеры вернули ошибки, а кандидатов 0 → `JobError::Retry { after: 10 min }` (временная проблема), при последней попытке — треки `not_found` + `no_torrents`.
7. Если кандидатов 0 и ошибок нет → треки альбома в статусе `adding` → `not_found` (`no_torrents`), публиковать `TrackStatus` по каждому.
8. Иначе — для каждой связанной раздачи `Job::VerifyTorrent { torrent_id, album_id }` (dedup). Раздачи, у которых `meta_status = 'ok'` (уже проверены ранее для другого альбома) — тоже ставим verify: шаг 17 переиспользует `torrent_files` без сети.

### 4. `DiscoverArtist { artist_id }`

1. Запросы `"{artist} discography"`, `"{artist} дискография"`, `"{artist}"`.
2. Кандидаты с `kind = discography` (и score без учёта альбома ≥ порога) → `upsert` → `album_torrents::link` **для каждого альбома артиста в библиотеке** (rank_score по дискографии + небольшой бонус).
3. Для каждого альбома артиста в библиотеке поставить `DiscoverAlbum` с задержкой (`run_after = now + i*5s`), чтобы не долбить трекеры. `DiscoverAlbum` увидит уже прилинкованные дискографии и добавит альбомные раздачи.

### 5. Конфиг

`FormatPrefs` и `N` пока — константы/`Default`; шаг 22 сделает их настройками.

## Тесты

- Unit: `classify` и `score` на таблице реальных названий раздач (минимум 20 строк: альбомы, дискографии, караоке, трибьюты, live, разные форматы, кириллица — например, «Кино - Группа крови (1988) [FLAC]», «Radiohead - Discography 1993-2016 (MP3 320)», «Radiohead - OK Computer OKNOTOK 1997 2017 [FLAC 24bit]», «Karaoke - Radiohead hits»).
- `#[sqlx::test]` + фейковый `TorrentProvider` (in-memory): handler создаёт torrents/album_torrents и verify-задачи; ноль кандидатов → `not_found/no_torrents` + события; ошибка всех провайдеров → `Retry`.
- `DiscoverArtist` линкует дискографию ко всем альбомам артиста.

## Критерии приёмки

- `just backend-test`, `just backend-check` проходят.
- Ручная проверка (если есть сеть до TPB): добавить OK Computer → в `GET /api/debug/jobs` появляются `verify_torrent`, в БД (`just psql`) — строки `torrents`/`album_torrents`.

## Вне рамок шага

Получение списка файлов и сопоставление (шаги 15–17).
