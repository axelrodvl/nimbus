# S01 — Ожидание «нажал — играет» может крутиться бесконечно

**Приоритет:** P1 · **Область:** `client/src/lib/search/play-remote.ts`, `backend/crates/api/src/catalog.rs` · **Зависит от:** —

## Проблема

`createPlayRemote` ждёт, пока трек станет играбельным, только по изменениям store. Итог «источник не найден»
распознаётся по флагу `searched`: `not_found` засчитывается, только если до этого клиент **видел** `adding`
(иначе это «старая строка store»). Промежуточный `adding` клиент может не увидеть:

1. **Переподключение.** Телефон погасил экран / PWA ушла в фон → WebSocket закрыт → поиск на сервере закончился
   `not_found` → при возврате дельта синхронизации приносит только итог `not_found`. `searched` остаётся `false`,
   `check()` молча выходит — спиннер в строке крутится вечно, toast давно скрыт.
2. **Объединение live-событий.** `sync/engine.ts` копит `track.status` 50 мс (`LIVE_FLUSH_MS`, «последнее по ключу
   побеждает»). Если поиск закончился быстро (нет включённых провайдеров → `mark_not_found` сразу), `adding` и
   `not_found` попадают в одну пачку — тот же результат.
3. **Трека ещё нет в store.** Альбом не открывался → строки придут синхронизацией уже в итоговом состоянии
   (`not_found` при повторе или быстром поиске) — тот же результат.
4. **Синхронизация молчит** (WS не переподключается, safety-poll раз в 5 минут) — ожидание ничем не ограничено.

Сервер при этом точно знает статус после пометки: `tracks::request_play` возвращает его (`PlayRequested.status`,
`reset`), но `PlayResponse` отдаёт только `track_ids`.

## Текущее состояние (прочитай перед началом)

- `client/src/lib/search/play-remote.ts` — `Pending.searched`, `check()`, `playRemote()` (обработка ответа `deps.request`).
- `client/src/lib/sync/engine.ts` — `LIVE_FLUSH_MS`, буфер live-событий, `SAFETY_POLL_MS`.
- `backend/crates/api/src/catalog.rs` — `PlayResponse`, `play`.
- `backend/crates/library/src/service.rs` — `request_play`, `PlayOutcome`.
- `backend/crates/db/src/repo/tracks.rs` — `request_play`, `PlayRequested`.
- Тесты: `client/src/lib/search/play-remote.test.ts`, `backend/crates/api/tests/catalog.rs`.

## Что сделать

1. **Статусы в ответе.** `PlayOutcome`/`PlayResponse` дополнить списком `tracks: [{ id, status }]` — статус каждого
   запрошенного трека сразу после пометки (из `PlayRequested`). `track_ids` оставить (совместимость). Обновить
   `openapi.json`, `schema.d.ts`, `docs/api.md` (`just docs-check`).
2. **Клиент: точка отсчёта от сервера.** В обработчике ответа: если сервер сказал `adding` для ожидаемого трека —
   `searched = true` (поиск гарантированно начат после нажатия; последующий `not_found` в store — итог). Если сервер
   сразу сказал `found`/`ready` — `check()` (играть, когда строка дойдёт до store). Если `not_found` (возможно только
   при гонке) — toast `play.noSource`.
3. **Сторож.** Пока ожидание активно и после ответа сервера прошло `PENDING_POLL_MS` (≈15 с) без изменений этого трека
   в store — запросить статус трека напрямую (существующий REST трека или `POST /api/sync`-дельта через движок
   синхронизации — выбери то, что уже есть; не добавляй новый эндпоинт без нужды) и прогнать `check()` по ответу.
   Повторять с тем же интервалом.
4. Состояние ожидания, которое не может завершиться (трек исчез из store после `prune`, ответ сервера без нужного id),
   — снимать с toast об ошибке, а не висеть.

## Тесты (обязательные)

Клиент (`play-remote.test.ts`, фейковые deps и таймеры):

- `server_adding_then_store_not_found_reports_no_source`: store до нажатия — `not_found`; ответ сервера `adding`;
  store сразу переходит в `not_found` (без промежуточного `adding`) → toast `play.noSource`, ожидание снято.
- `track_absent_until_final_state`: трека нет в store; ответ `adding`; строка появляется сразу `not_found` → toast.
- `watchdog_polls_when_store_is_silent`: ответ `adding`, store не меняется; через `PENDING_POLL_MS` вызывается
  запрос статуса; он вернул `found` → `play` вызван.
- Существующие тесты (повторное нажатие отменяет, смена трека в плеере отменяет) зелёные.

Бэкенд (`tests/catalog.rs`): `play_returns_statuses_after_marking` — для `not_found`-трека ответ `adding`, для
`found` — `found`.

## Критерии приёмки

- `just check`, `just client-test`, `just backend-test`, `just docs-check` зелёные.
- Ручная проверка (опиши в Журнале): нажать трек, сразу перевести вкладку в офлайн (DevTools), дождаться итога на
  сервере, вернуть сеть — ожидание завершается (играет или toast), спиннер не остаётся.

## Не входит

- Визуальное оформление ожидания и длинные поиски — S02.
