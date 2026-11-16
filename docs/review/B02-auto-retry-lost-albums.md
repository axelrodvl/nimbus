# B02 — Альбомы выпадают из авто-повтора поиска

**Приоритет:** P1 · **Область:** `backend/crates/db`, `backend/crates/worker` · **Зависит от:** —

## Проблема

Авто-повтор держится на `album_search_state.next_retry_at`. Есть два пути, на которых поле становится `NULL`
у альбома с ненайденными треками, и больше его никто не выставит — альбом остаётся без поиска до ручного
«Повторить».

1. **`take_due` стирает расписание у альбома в состоянии `downloading`.** Первый запрос `take_due`
   (`db/src/repo/acquisition.rs`) обнуляет `next_retry_at` всем просроченным строкам, чьё вычисляемое состояние
   не `missing`/`partial`. Но состояние `downloading` имеет приоритет над `partial`: альбом, у которого часть
   треков `not_found`, а у найденных есть незавершённая строка `downloads` (идёт или зависла загрузка, недокачанный
   стрим), считается `downloading`. Подошёл срок повтора → расписание стёрто → после окончания загрузки альбом
   снова `partial`, но уже с `next_retry_at IS NULL`.
   То же сужение в `schedule_missing_now` (смена провайдеров не затронет такой альбом).
2. **Треки стали `not_found` без «начатого поиска».** `finish_search` пишет расписание только если
   `last_started_at > last_finished_at`. Если `discover_album` исчерпал попытки до `mark_search_started`
   (ошибки БД на `load_album`/`list_by_album`, зависший воркер) — `on_exhausted` → `mark_not_found` → `finish_search`
   ничего не обновляет (строки `album_search_state` может вообще не быть).

## Текущее состояние (прочитай перед началом)

- `backend/crates/db/src/repo/acquisition.rs` — `state_cte!`, `finish_search`, `take_due`, `schedule_missing_now`.
- `backend/crates/worker/src/acquisition.rs` — `RetryMissingHandler`.
- `backend/crates/worker/src/discover.rs` — `mark_not_found`, `on_exhausted`.
- `backend/crates/library/src/retry.rs` — `retry_album_in`.
- Тесты: `backend/crates/db/tests/acquisition.rs`, `backend/crates/worker/tests/retry_missing.rs`.

## Что сделать

1. Ввести в `acquisition.rs` единое условие «альбому нужен повтор поиска»: в библиотеке есть трек `not_found`
   и нет треков `adding` (`tr.not_found > 0 AND tr.adding = 0`) — независимо от загрузок. Использовать его
   вместо `st.state IN ('missing','partial')` в `take_due` (оба запроса) и в `schedule_missing_now`.
   Состояние `downloading` с ненайденными треками теперь попадает в повтор.
2. Первый запрос `take_due` (сброс) оставить только для альбомов, которым повтор не нужен **и** которые не ищутся:
   `tr.not_found = 0 AND tr.adding = 0` (всё найдено). Альбом с `adding > 0` не трогаем — расписание
   перезапишет `finish_search`.
3. `finish_search`: строка должна появляться и обновляться всегда, когда поиск реально завершается.
   Сделать `INSERT … ON CONFLICT (album_id) DO UPDATE`; условие «один раз на поиск» сохранить для строк,
   у которых `last_started_at` задан, а для строк без начатого поиска (`last_started_at IS NULL` или строки нет)
   — записать итог и `next_retry_at`, если у альбома есть `not_found`-треки и `next_retry_at IS NULL`.
   Повторный вызов без изменений по-прежнему ничего не пишет (идемпотентность, возвращает `None`).
4. **Страховка в `RetryMissing`.** Новая функция `acquisition::adopt_orphans(tx, limit)`: альбомы, которым нужен
   повтор (условие п. 1), с `next_retry_at IS NULL` (или без строки состояния), без активной задачи
   `discover_album:{id}` / `discover_artist:{artist}` в `jobs` (`state IN ('queued','running')`), у которых
   `COALESCE(last_finished_at, '-infinity') < now() - interval '6 hours'` → `next_retry_at = now()`
   (upsert). Вызывать в начале `RetryMissingHandler::handle` в той же транзакции, до `take_due`;
   число усыновлённых — в лог (`warn`, это признак дыры).
5. Обновить doc-комментарии `take_due`, `finish_search`, шапку `state_cte!`.

## Тесты (обязательные)

`db/tests/acquisition.rs`:

- `take_due_keeps_schedule_while_downloading`: альбом с треками `found` + `not_found`, у найденного незавершённая
  строка `downloads`, `next_retry_at` в прошлом → `take_due` возвращает альбом (и не обнуляет расписание молча).
- `take_due_resets_only_fully_found`: альбом, где все треки `found`/`ready`, с просроченным `next_retry_at` → сброс.
- `finish_search_without_started_search_schedules_retry`: треки `not_found`, строки состояния нет → после
  `finish_search` строка есть, `next_retry_at` задан; второй вызов возвращает `None`.
- `adopt_orphans_*`: усыновляет альбом без расписания; не трогает альбом с активной `discover_album`;
  не трогает альбом, поиск которого закончился меньше 6 часов назад; не трогает полностью найденный.
- `schedule_missing_now_includes_downloading_with_not_found`.

`worker/tests/retry_missing.rs`:

- `orphan_album_gets_search`: альбом `missing` без строки состояния → после задачи `RetryMissing` в очереди
  `discover_album`, треки `adding`.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov` зелёные.
- Существующие тесты расписания (`search_failed` 10 мин…, обычное 6 ч…) не изменены по смыслу.

## Не входит

- Изменение интервалов расписания и размера порции `BATCH`.
