# Шаг 29 — Конвейер поиска без пауз: потоковый импорт, лимитеры, предохранители

**Фаза 1 · Зависит от:** 26, 28 · **Закрывает находки:** D1, D2, D4, D5

## Зачем

Добавление артиста сейчас идёт «водопадом» с искусственными паузами: сначала все альбомы из MusicBrainz,
потом поиск дискографий, потом альбомы по одному раз в 5 секунд. После шага первый альбом начинает
искаться, как только импортирован, провайдеры опрашиваются с максимальным темпом, который они
допускают, а упавший провайдер не тормозит остальных.

## Текущее состояние

- `backend/crates/library/src/service.rs` — `import_artist_skipping`: цикл по release group, `add_album_inner(.., discover = false)`, в конце `Job::DiscoverArtist`.
- `backend/crates/worker/src/discover.rs`:
  - `ALBUM_JOB_STAGGER = 5 с`, `VERIFY_STAGGER = 200 мс`, `EARLY_WAVE = 3`, `ALBUM_QUERY_COUNT = 3`, `RETRY_AFTER = 10 мин`;
  - `discover_artist`: ищет дискографии, привязывает их ко **всем** альбомам артиста в библиотеке и ставит `DiscoverAlbum` на каждый со сдвигом;
  - `discover_album`: две волны `persist_all` → `enqueue_verifies`.
- `backend/crates/worker/src/verify.rs` — `verify_torrent` (N+1 запросов на каждый match), `finalize` (проверяет `has_queued_discover`).
- `backend/crates/trackers/src/registry.rs` — `search_all` (join по провайдерам, `PROVIDER_TIMEOUT = 20 с`); `limiter.rs` — `governor`, 1 запрос / интервал (`DEFAULT_INTERVAL = 2 с`, `FAST_INTERVAL = 500 мс`).
- Приоритеты очереди и `PerformanceSettings` — после шага 26; `.torrent` в БД — после шага 28.

## Что сделать

1. **Потоковый импорт артиста.** В `import_artist_skipping`:
   - в **начале** импорта поставить `Job::DiscoverArtist` (поиск дискографий идёт параллельно импорту из MB);
   - после успешного `add_album_inner` каждого альбома **сразу** ставить `Job::DiscoverAlbum` (приоритет `NORMAL`);
   - в конце ничего не ставить.
2. **`discover_artist` больше не ставит `DiscoverAlbum`.** Он находит дискографии, сохраняет и привязывает их
   к альбомам артиста, уже находящимся в библиотеке, и ставит `VerifyTorrent(torrent, album)` для каждой пары.
   Альбом, импортированный **после** того, как дискографии найдены, должен получить те же привязки:
   в `discover_album` перед своим поиском привязать к альбому все известные раздачи `kind = discography`
   этого артиста (новая функция репозитория `album_torrents::link_artist_discographies(album_id)`), и
   поставить для них verify.
3. **`finalize` учитывает поиск дискографий.** Альбом нельзя объявлять `not_found`, пока активна (`queued`/`running`)
   задача `discover_artist` его артиста. Обобщи `jobs::has_queued_discover(album_id)` → учитывать оба ключа
   (`discover_album:{album}` и `discover_artist:{artist}`); когда `discover_artist` завершается, он вызывает
   `finalize_album` для всех альбомов артиста в библиотеке (иначе некому будет финализировать).
4. **Убрать паузы.** Удалить `ALBUM_JOB_STAGGER`, `VERIFY_STAGGER` и сдвиги `run_after` при постановке задач.
   Порядок проверки раздач задаётся приоритетом: первая волна (`EARLY_WAVE`) — приоритет задачи discover + 1,
   остальные — тот же приоритет; резервные (когда все треки найдены) — `BACKGROUND` (механизм шага 26).
5. **Лимитер провайдера: темп + параллелизм.** Заменить `trackers::Limiter` на структуру с двумя параметрами:
   `min_interval` (как сейчас, `governor`) и `max_concurrent` (семафор). Значения по умолчанию:
   TPB/apibay — 250 мс и 4; Torznab (свой индексер) — 100 мс и 8; RuTracker — 1 с и 2 (сайт банит за напор — не снижать ниже).
   `acquire()` возвращает guard, удерживаемый на время HTTP-запроса. Значения — константы в коде с doc-комментарием «почему столько».
6. **Предохранитель (circuit breaker) в `ProviderRegistry`.** На провайдера: после 3 подряд неудач
   (таймаут/сеть/5xx; ошибки авторизации RuTracker — сразу) провайдер «разомкнут» на 60 с (далее 2, 5, 10 мин при повторных срабатываниях):
   `search_all` сразу возвращает для него `ProviderError::CircuitOpen`, не делая запроса. Первый успешный запрос после паузы замыкает.
   Состояние видно в `GET /api/health` (`providers: [{ source, state: "ok"|"open", last_error, open_until }]`).
   `discover_album`: если **все** включённые провайдеры разомкнуты/упали и кандидатов нет — `Retry` (как сейчас при `provider_errors > 0`), иначе работаем с тем, что есть.
7. **Таймаут провайдера** снизить до 12 с на запрос (`PROVIDER_TIMEOUT`), connect — 5 с.
8. **Кэш поисковых запросов провайдеров.** Одинаковый запрос к тому же провайдеру в пределах 10 минут
   не повторяется: кэш в памяти в `ProviderRegistry` (ключ — `source + нормализованный текст запроса`, LRU на 512 записей, single-flight для одновременных одинаковых запросов).
   Это убирает дубли при импорте артиста (общие запросы «artist discography», повтор альбома).
9. **`verify_torrent` без N+1.** Вставку `track_sources` и выбор primary выполнить пакетно:
   `track_sources::insert_many(&[NewTrackSource])` (один `INSERT … SELECT * FROM UNNEST(...) ON CONFLICT DO NOTHING`),
   `track_sources::ensure_primaries(track_ids)` (один запрос: для треков без primary выбрать лучший по
   `(needs_confirmation, match_score DESC, id)`), статусы `adding|not_found → found` — одним `UPDATE … RETURNING` + публикация событий.
   Всё — в одной транзакции.
10. **Документация:** `docs/architecture.md` («Конвейер») — новая последовательность и параллелизм.

## Тесты (обязательные)

`crates/worker/tests/discover.rs`, `crates/library` (тесты импорта — в `crates/api/tests/library.rs` или новом `crates/library/tests/import.rs`):
- импорт артиста из 3 альбомов: `DiscoverArtist` в очереди **до** импорта первого альбома; `DiscoverAlbum` появляется после каждого альбома; ни у одной задачи `run_after` не в будущем;
- альбом, импортированный после завершения `discover_artist`, получает привязку к найденной дискографии и verify на неё;
- `finalize` не помечает альбом `not_found`, пока `discover_artist` артиста активен; после его завершения — помечает (если ничего не нашлось);
- приоритеты verify: первая волна выше остальных; резервные — `BACKGROUND`.

`crates/trackers`:
- лимитер: при `max_concurrent = 2` одновременно идёт не больше 2 запросов (wiremock с задержкой + счётчик), `min_interval` соблюдается (`tokio::time::pause`);
- предохранитель: 3 неудачи → следующий вызов не делает HTTP-запроса и возвращает `CircuitOpen`; через паузу — пробный запрос; успех замыкает; рост паузы при повторе;
- кэш запросов: два одинаковых запроса подряд → один HTTP-запрос; одновременные — тоже один; разные провайдеры не делят кэш; ошибка не кэшируется.

`crates/worker/tests/verify.rs`:
- пакетная запись: результат идентичен прежнему на существующих сценариях (все существующие тесты проходят без изменения ожиданий);
- повторный verify той же раздачи не создаёт дублей и не меняет primary.

`crates/api/tests/health.rs`: блок `providers` в ответе.

**Измерение (в Журнал):** интеграционный тест-бенчмарк `#[ignore]` (`cargo test -p nimbus-worker --test pipeline_bench -- --ignored --nocapture`):
артист с 30 альбомами, фейковые MB/провайдер/fetcher с задержкой 50 мс → время от `add_artist` до состояния «все треки `found`». Запиши «до» (на коммите до шага) и «после».

## Критерии приёмки

```
just db-up && just check && just test && just cov
grep -nE "ALBUM_JOB_STAGGER|VERIFY_STAGGER" -r backend/crates && exit 1 || true
just openapi && just web-gen-api && just web-check
```

## Не входит в шаг

- Ускорение самого MusicBrainz (шаг 30) — здесь импорт остаётся последовательным по альбомам.
- Автоповтор не найденного (шаг 32).

## Подводные камни

- Гонка «`discover_artist` завершился ↔ альбом ещё импортируется»: привязка дискографий в `discover_album` (п. 2) закрывает её; тест на оба порядка обязателен.
- `dedup_key` у `VerifyTorrent` — `torrent:album`; повторная постановка той же пары безопасна (вернётся `None`).
- Кэш запросов не должен переживать `ProviderRegistry::reload` (смена настроек провайдеров) — очищай при reload; предохранители тоже сбрасывай.
- RuTracker: параллельные запросы делят одну сессию/cookie; повторный логин должен быть single-flight (проверь существующий код логина и добавь тест, если защиты нет).
