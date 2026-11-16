# B12 — Образ с CUE: временная неудача навсегда лишает альбом источника

**Приоритет:** P1 · **Область:** `backend/crates/worker` (`cue.rs`), `backend/crates/db` (`cue_candidates.rs`), `backend/crates/library` (`retry.rs`) · **Зависит от:** —

## Проблема

Раздача «образ + .cue» превращается в источники треков задачей `process_cue`: она скачивает CUE-файл из торрента
и привязывает треки к отрезкам образа. Скачивание зависит от пиров:

- нет пиров → `cue file download timeout` → `Retry` через 60 с; попыток 5 → через ≈ 5–10 минут задача исчерпана;
- `on_exhausted` помечает кандидата `processed = TRUE` (чтобы не блокировать финализацию) — и это **навсегда**:
  - `RetryMissing` → `reset_dead` сбрасывает только раздачи с `meta_status in (dead, timeout, error)`; у этой раздачи
    метаданные получены (`ok`), связь `verified = TRUE` — повторной проверки нет;
  - `process_cue` для обработанного кандидата сразу выходит (`if candidate.processed { return Ok(()) }`),
    да и ставить его некому.

Итог: альбом, существующий только в виде образа с CUE, чей раздающий был офлайн десять минут, остаётся
`not_found(no_match)` при живой раздаче, пока не найдётся другая. Окончательная причина (битый CUE — `Fatal`)
и временная (нет пиров, ошибка движка/диска) сейчас неразличимы.

## Текущее состояние (прочитай перед началом)

- `backend/crates/worker/src/cue.rs` — `ProcessCueHandler` (`on_exhausted`), `fetch_cue`, `process_cue`,
  `CUE_FETCH_TIMEOUT`, `RETRY_AFTER`.
- `backend/crates/db/src/repo/cue_candidates.rs` — `upsert`, `get`, `mark_processed`, `count_pending`.
- `backend/migrations/0003_cue_candidates.sql`.
- `backend/crates/library/src/retry.rs` — `retry_album_in`, `RetryOptions { reset_dead }`.
- `backend/crates/db/src/repo/album_torrents.rs` — `reset_dead`.
- `JobHandler::on_exhausted(job, ctx, reason)` — причина приходит строкой; после B05 в строке задачи есть `fatal`.
- Тесты: `backend/crates/worker/tests/cue.rs`, `retry_missing.rs`.

## Что сделать

1. **Схема.** Миграция: `ALTER TABLE cue_candidates ADD COLUMN failed BOOLEAN NOT NULL DEFAULT FALSE;`
   — «обработка не удалась по временной причине, повторить при следующем повторе альбома».
   Существующим обработанным кандидатам, от которых не появилось ни одного источника
   (`NOT EXISTS (SELECT 1 FROM track_sources ts WHERE ts.torrent_id = c.torrent_id AND ts.cue_start_ms IS NOT NULL)`),
   выставить `failed = TRUE` — они получат вторую попытку.
2. **Различать причины.** `ProcessCueHandler::on_exhausted`: окончательная причина — только `JobError::Fatal`
   (битый CUE, нет кандидата/раздачи/альбома). Обработчику нужно знать, фатален ли провал: расширить
   `on_exhausted` параметром `fatal: bool` (раннер знает вид ошибки; для `requeue_stale`/`defer` — `false`)
   и обновить все реализации. Для CUE: `fatal` → `mark_processed` как сейчас; иначе → `cue_candidates::mark_failed`
   (`processed = TRUE, failed = TRUE`). В обоих случаях затем `finalize_album`.
3. **Больше терпения до исчерпания.** Задаче `process_cue` ставить `max_attempts = 8`, пауза при таймауте
   скачивания/метаданных растёт: 1, 2, 5, 10, 20, 30, 30 мин (по `ctx.attempt`) — около полутора часов вместо
   десяти минут. Ошибки движка, отличные от таймаута метаданных (`Io`, `Storage`, `Internal`), — тоже `Retry`
   с этой лестницей, а не `Unexpected`.
4. **Повтор вместе с альбомом.** В `retry_album_in` при `opts.reset_dead` (авто-повтор и ручной «Повторить»):
   `cue_candidates::reset_failed(album_id) -> Vec<(torrent_id, cue_file_index)>` (`processed = FALSE, failed = FALSE`
   для `failed`-кандидатов альбома) и для каждого — `jobs::enqueue(ProcessCue { … })` в той же транзакции,
   с приоритетом повтора. `process_cue` идемпотентен (`track_sources::insert` — проверить, что повторная вставка
   того же источника не даёт ошибку уникальности; если даёт — заменить на upsert).
5. `discover_album`, запущенный повтором, финализирует альбом только после разбора CUE
   (`cue_candidates::count_pending` уже учитывается в `finalize`) — проверить тестом.

## Тесты (обязательные)

`worker/tests/cue.rs`:

- `cue_timeout_exhaustion_marks_failed_not_final`: провайдер файлов не отдаёт CUE → после исчерпания кандидат
  `processed && failed`, альбом финализирован (`not_found`), не висит в `adding`.
- `bad_cue_sheet_is_final`: битый CUE → `processed && !failed`.
- `engine_io_error_is_retried`.
- `retry_delays_grow`.

`worker/tests/retry_missing.rs`:

- `auto_retry_reprocesses_failed_cue`: альбом `not_found` с `failed`-кандидатом; файлы теперь доступны → после
  `RetryMissing` и выполнения задач треки `found` с источниками `cue_start_ms`.
- `auto_retry_does_not_touch_final_cue`.

`db/tests/repos.rs`: `mark_failed`, `reset_failed`.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov` зелёные.

## Не входит

- Повторное сопоставление файлов раздач, чьи метаданные уже получены (`no_match` остаётся `no_match`).
