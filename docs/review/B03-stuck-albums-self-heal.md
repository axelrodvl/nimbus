# B03 — Альбом навсегда в `adding`: раздача или CUE без задачи

**Приоритет:** P1 · **Область:** `backend/crates/worker`, `backend/crates/db` · **Зависит от:** —

## Проблема

`finalize` (`worker/src/verify.rs`) не принимает решение по альбому, пока есть непроверенная связь
`album_torrents.verified = FALSE` или необработанный `cue_candidates`. Предполагается, что для каждой такой записи
существует задача `verify_torrent` / `process_cue`, которая в конце (или в `on_exhausted`) снимет блокировку.
Но запись и задача создаются **разными операциями**, не в одной транзакции:

- `discover_album`: `album_torrents::link(...)`, затем `enqueue_verifies(...)`. Если задача поиска окончательно
  провалилась между ними (ошибка БД на последней попытке, исчерпание после зависаний) — `on_exhausted` видит
  привязанные раздачи, зовёт `finalize_album`, тот видит `count_unverified > 0` и выходит. Задачи проверки нет.
- `discover_artist`: `link_artist_discographies` → `enqueue_verify` — то же.
- `verify_torrent`: `cue_candidates::upsert` → `jobs::enqueue(ProcessCue)`. При исчерпании `on_exhausted`
  помечает раздачу проверенной, но кандидат CUE остаётся `pending` без задачи.
- Задача с непарсящимся payload получает `failed` без вызова `on_exhausted` (`runner.rs`, `process`).

Обслуживание (`finalize_stuck_albums`) раз в минуту снова зовёт `finalize` и снова выходит. Треки остаются
`adding` бессрочно, авто-повтор (`RetryMissing`) такие альбомы не берёт — они «ищутся».

## Текущее состояние (прочитай перед началом)

- `backend/crates/worker/src/verify.rs` — `finalize`, `finalize_stuck_albums`.
- `backend/crates/worker/src/discover.rs` — `enqueue_verifies`, `discover_album`, `discover_artist`.
- `backend/crates/worker/src/cue.rs` — `ProcessCueHandler`.
- `backend/crates/db/src/repo/tracks.rs` — `albums_stuck_in_adding`.
- `backend/crates/db/src/repo/album_torrents.rs`, `cue_candidates.rs` — `count_unverified`, `count_pending`, `list_for_album`.
- `backend/crates/worker/src/runner.rs` — `maintenance_loop`.

## Что сделать

1. **Самовосстановление в обслуживании.** В `finalize_stuck_albums` для каждого «застрявшего» альбома
   (выборка `albums_stuck_in_adding` уже отбирает альбомы без активного поиска и старше `stuck_grace`)
   перед `finalize_album`:
   - для каждой непроверенной связи альбома поставить `Job::VerifyTorrent { torrent_id, album_id }`
     с `PRIORITY_NORMAL` — `enqueue` идемпотентен (активная задача с тем же ключом не дублируется);
   - для каждого необработанного кандидата CUE поставить `Job::ProcessCue { … }`.
   Нужные выборки — новые функции в репозиториях: `album_torrents::unverified_ids(album_id) -> Vec<i64>`,
   `cue_candidates::pending(album_id) -> Vec<(torrent_id, cue_file_index)>`.
   Сколько задач восстановлено — в лог `warn` с `album_id` (это сигнал о дыре, а не штатный путь).
2. **Обслуживание не обрывается на первой ошибке.** Сейчас `finalize_stuck_albums` выходит по `?` на первом
   альбоме с ошибкой. Обрабатывать каждый альбом отдельно: ошибку логировать с `album_id`, продолжать, вернуть
   число успешно обработанных.
3. **Атомарная привязка + постановка там, где это дёшево.** В `verify_torrent` `cue_candidates::upsert` и
   `jobs::enqueue(ProcessCue)` выполнять в одной транзакции (обе функции принимают `PgExecutor`).
   В `discover_*` оставить как есть (резолв кандидатов идёт по сети между привязками) — эту часть закрывает п. 1.
4. **Задача с плохим payload.** В `process` (`runner.rs`) ветка `bad payload` ничего не чинит и чинить не может
   (нет `Job`), оставить; но добавить в лог `dedup_key`, чтобы запись можно было сопоставить. Альбом такой задачи
   восстановит п. 1.

## Тесты (обязательные)

`worker/tests/verify.rs` (или новый `tests/self_heal.rs`):

- `stuck_album_with_unverified_link_gets_verify_job`: альбом с треками `adding` (старше `grace`), связь
  `verified = FALSE`, задач нет → `finalize_stuck_albums` ставит `verify_torrent`; после её выполнения альбом
  финализирован (`found` или `not_found`), `adding` не осталось.
- `stuck_album_with_pending_cue_gets_cue_job`: то же для кандидата CUE.
- `self_heal_does_not_duplicate_active_job`: при уже стоящей `verify_torrent` новая не создаётся.
- `finalize_stuck_continues_after_error`: два застрявших альбома, первый вызывает ошибку (например, удалён
  артист/нарушена ссылка в фейке) → второй всё равно обработан.
- `cue_candidate_and_job_are_atomic`: после успешного `verify_torrent` на каждый `pending`-кандидат есть активная
  задача `process_cue`.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov` зелёные.
- В описании `finalize_stuck_albums` отражено новое поведение.

## Не входит

- Перенос привязки и постановки проверок `discover_*` в одну транзакцию.
