# S07 — Трек из поиска не играет: «Этого трека нет в треклисте альбома»

**Приоритет:** P2 · **Область:** `backend/crates/library/src/service.rs`, `backend/crates/musicbrainz` · **Зависит от:** —

## Проблема

Строка трека в результатах поиска передаёт `album_mbid` = группа релизов, выбранная `pick_release_group` среди
релизов записи (ранг типа, Official, самая ранняя дата). `play_track` (как и `add_track`) берёт треклист
**каноничного релиза** этой группы (`canonical_release_with_tracklist`) и ищет в нём запись. Если записи там нет —
`422 recording_not_in_release`, toast «This track isn't in the album's tracklist».

Это частый случай, а не экзотика:

- бонус-трек есть только в deluxe/японском издании, каноничный релиз — стандартный;
- запись есть в группе только в одном из изданий с другим мастерингом (другая recording MBID в каноничном);
- у записи нет релизов вовсе (`release_group_mbid = None`) — `play_track` без альбома идёт в `recording()` и получает
  тот же 422.

Раньше это касалось только «Добавить трек»; теперь нажатие на строку — основное действие поиска, и пользователь
получает ошибку на треке, который сам нашёл.

## Текущее состояние (прочитай перед началом)

- `backend/crates/library/src/service.rs` — `play_track`, `add_track` (та же логика), `ensure_album_with`,
  `ensure_album_from`.
- `backend/crates/musicbrainz/src/client.rs` — `canonical_release_with_tracklist`, `complete_canonical` (браузинг
  релизов группы — смотри, приходят ли в нём треклисты всех релизов), `recording`.
- `backend/crates/musicbrainz/src/model.rs` — `pick_release_group`, `RecordingHit`.
- `backend/crates/db/src/repo/tracks.rs` — `upsert_by_mbid_track` (уникальность трека; ограничения на
  `(album_id, disc_no, position)` — проверь в миграциях).
- Тесты: `backend/crates/library/tests/`, `backend/crates/api/tests/catalog.rs`, фикстуры MusicBrainz.

## Что сделать

1. Если записи нет в треклисте каноничного релиза: найти среди релизов этой группы тот, где запись есть (по
   данным, которые уже приходят при выборе каноничного релиза, иначе — один дополнительный запрос `recording?inc=releases+media`).
2. Добавить трек в **существующий** альбом (группа релизов одна, альбом один): `NewTrack` с `mbid_track` из найденного
   релиза; `disc_no/position` — из него, а при конфликте с треками каноничного релиза — после последнего трека
   последнего диска (бонус в конце). Решение по нумерации зафиксировать комментарием и в Журнале.
3. Запись без релизов: `422` остаётся, но с понятным текстом (`error.recording_not_in_release` переписать на «У этой
   записи нет альбома в MusicBrainz — её нельзя найти в раздачах») во всех 14 языках.
4. То же поведение для `add_track` (общий helper), чтобы «Слушать» и «Добавить» не расходились.

## Тесты (обязательные)

- `play_track_finds_bonus_track_outside_canonical_release`: фикстура группы с двумя релизами, запись только во
  втором → 200, трек создан в альбоме, `track_ids` содержит его, позиция не конфликтует.
- `add_track_finds_bonus_track_outside_canonical_release` — то же для добавления.
- `play_track_without_releases_is_422` — сохраняется.
- Повторный `play_track` идемпотентен (второй вызов не создаёт дубль и не ходит в MusicBrainz).

## Критерии приёмки

- `just check`, `just backend-test`, `just cov` зелёные.

## Не входит

- Выбор другого каноничного релиза для всего альбома.
