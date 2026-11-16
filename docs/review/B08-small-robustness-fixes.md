# B08 — Мелкие дыры надёжности

**Приоритет:** P2 · **Область:** `backend/crates/api` (`stream.rs`), `backend/crates/worker`, `backend/crates/db` · **Зависит от:** —

Три независимых небольших исправления. Каждое — со своим регрессионным тестом; коммит один.

## 1. Завершение загрузки: файл `completed`, а треки остались `found`

`Watcher::tick` (`api/src/stream.rs`) для докачанного файла делает по очереди: `downloads::mark_completed`,
затем `set_track_status_and_publish(Ready)` для каждого трека. Если второй шаг упал (ошибка БД), на следующем тике
файла уже нет в `list_active_with_hash` (он завершён) — треки остаются `found`, хотя файл на диске.
`DownloadManager` при этом считает закрепление `Done` («Watcher вот-вот переведёт»). `reconcile_downloads` на старте
чинит только обратный случай (файл пропал).

**Сделать:**

- Поменять порядок: сначала треки `found → ready`, потом `mark_completed` (если упадёт второе — следующий тик
  увидит незавершённую загрузку с `finished` и повторит; перевод статуса идемпотентен). Лучше — одна транзакция:
  `mark_completed` + `tracks::set_status` для всех треков, события публиковать после коммита.
- В `reconcile_downloads` добавить вторую проверку: завершённая загрузка, файл существует, а у файла есть
  primary-треки в `found` → перевести в `ready` (выборка `track_sources::tracks_with_primary(…, Found)`).

**Тест** (`api/tests/stream.rs` или `download_manager.rs`): `completed_download_with_found_tracks_is_healed_on_start`;
`watcher_marks_ready_before_completed` — при искусственной ошибке на втором шаге следующий тик доводит до `ready`.

## 2. Возраст `Defer` считается от создания задачи

`jobs::defer` переводит задачу в `failed`, если `created_at < now() - DEFER_MAX_AGE` (6 ч). Задача, простоявшая
в очереди 6 часов за большим импортом (фоновый приоритет), при первом же `Defer` сразу проваливается — её ни разу
не откладывали. Для `discover_album` это даёт `search_failed` и повтор через 10 минут (не теряется), но смысл
ограничения — «не откладывать бесконечно», а не «не жить дольше 6 часов».

**Сделать:** миграция `ALTER TABLE jobs ADD COLUMN deferred_since TIMESTAMPTZ;`. `defer` выставляет
`deferred_since = COALESCE(deferred_since, now())` и сравнивает возраст с ним; `complete`, `fail` (любой исход),
`retry` обнуляют поле. Обновить doc-комментарии `defer` и `DEFER_MAX_AGE`.

**Тесты** (`db/tests/jobs.rs`): `defer_age_counts_from_first_defer` (старая задача, первый `Defer` → `queued`);
`defer_expires_after_max_age_since_first_defer`; существующий тест «исчерпывается по возрасту» переписать на
`deferred_since`.

## 3. Обслуживание и `RetryMissing`: одна ошибка не должна останавливать остальных

- `maintenance_loop` (`worker/src/runner.rs`): шаги независимы и уже логируют ошибки — оставить.
  Но `RetryMissingHandler::handle` (`worker/src/acquisition.rs`) выполняет до 200 `retry_album_in` в одной
  транзакции: ошибка на одном альбоме (например, альбом удалён между выборкой и повтором, нарушение ссылки)
  откатывает всю порцию, и та же порция будет падать каждые 5 минут — авто-повтор стоит целиком.

**Сделать:** каждый альбом — в своей точке сохранения (`SAVEPOINT`, в sqlx — вложенная транзакция
`tx.begin()`): при ошибке альбома откатить только его, вернуть ему расписание (`next_retry_at = now() + 1 hour`,
`auto_retries` не увеличивать — новая функция `acquisition::postpone(album_id, interval)`), залогировать `warn`
с `album_id` и продолжить. Задача завершается успешно, если обработан хотя бы один альбом или порция пуста;
если упали все — вернуть `JobError::Unexpected` (общая причина, пусть сработает backoff).

**Тест** (`worker/tests/retry_missing.rs`): `one_bad_album_does_not_block_batch` — три альбома к повтору, для второго
повтор падает (подготовить состояние, на котором `retry_album_in` даёт ошибку, либо внедрить сбой через тестовый
хук) → первый и третий получили `discover_album`, второй отложен на час, задача `done`.

## Критерии приёмки

- `just check`, `just backend-test`, `just cov` зелёные.

## Не входит

- Изменение интервалов `DEFER_MAX_AGE`, `BATCH`.
