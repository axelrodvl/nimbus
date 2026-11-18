# S06 — `POST /api/play` без таймаута: нажатие может висеть минутами

**Приоритет:** P2 · **Область:** `backend/crates/api/src/catalog.rs`, `client/src/lib/api/catalog.ts`, `client/src/lib/search/play-remote.ts` · **Зависит от:** —

## Проблема

`GET /api/catalog/*` ограничены `CATALOG_TIMEOUT` (30 с → `503 mb_unavailable`, клиент повторяет сам). `POST /api/play`
— нет: `play_track` при пустой БД делает несколько запросов к MusicBrainz подряд (`recording`, если нет `album_mbid`;
`release_group`; `canonical_release_with_tracklist`), каждый под лимитером 1 запрос/с и с повторами на 503/429
(`MAX_RETRIES`, паузы `retry_delay · 2^n` — до десятков секунд каждая). При троттлинге MusicBrainz или идущем импорте
артиста ответ может прийти через минуты.

На клиенте `requestPlay` тоже без таймаута/`AbortSignal`. Пользователь видит toast 8 с, дальше спиннер; ответа нет —
ни ошибки, ни поиска (поиск источника ещё не поставлен, его ставит этот же запрос).

## Текущее состояние (прочитай перед началом)

- `backend/crates/api/src/catalog.rs` — `CATALOG_TIMEOUT`, `mb_call`, `catalog_album` (пример с таймаутом), `play`.
- `backend/crates/library/src/service.rs` — `play_track`, `play_album`, `ensure_album_with`.
- `backend/crates/musicbrainz/src/client.rs` — повторы на 503/429.
- `client/src/lib/api/catalog.ts` — `requestPlay`; `client/src/lib/search/play-remote.ts` — обработка ошибки запроса.
- `client/src/lib/search/use-remote-search.ts` — `shouldRetry`/`retryDelay` (как поиск повторяет 5xx).

## Что сделать

1. Бэкенд: обернуть `play` в тот же `CATALOG_TIMEOUT` → `503 mb_unavailable` (`LibraryError::MbUnavailable("timeout")`).
   Таймаут не должен оставить полузаписанное: транзакция `request_play` либо зафиксирована, либо нет — проверь, что
   отмена future до `commit` безопасна (откат) и после `commit` ответ всё равно 200 (таймаут — только вокруг
   MusicBrainz-части: `ensure_album`/`recording`, а не вокруг `request_play`).
2. Клиент: `requestPlay` принимает `signal`; `play-remote` отменяет запрос при `cancel()` и при замене ожидания.
3. Клиент: `503 mb_unavailable`/сеть — **один** автоматический повтор через `retryDelay(1)` с текстом в индикаторе
   ожидания «MusicBrainz не отвечает, пробуем ещё раз…»; вторая неудача — toast ошибки с кнопкой «Повторить».
4. `docs/api.md` и OpenAPI: у `/api/play` ответ 503 описан как таймаут.

## Тесты (обязательные)

- `tests/catalog.rs`: `play_times_out_as_mb_unavailable` — фейковый MusicBrainz отвечает дольше таймаута (уменьши
  таймаут через конфиг/константу для теста, как в тестах каталога) → 503 `mb_unavailable`, в БД нет `play_requested`.
- `play-remote.test.ts`: `cancel_aborts_request` (сигнал отменён); `retries_once_on_503`; `second_503_shows_retry_toast`.

## Критерии приёмки

- `just check`, `just backend-test`, `just client-test`, `just docs-check` зелёные.

## Не входит

- Изменение повторов внутри `MbClient` (`MAX_RETRIES`).
