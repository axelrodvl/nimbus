# Nimbus — дорожная карта (шаги 25–55)

Продолжение `PLAN.md` (шаги 01–23 выполнены, MVP работает). Основание — [`docs/architecture-review.md`](docs/architecture-review.md).
Правила, обязательные для каждого шага, — [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

**Цели:**

1. **Бэкенд rock solid** — вся функциональность, включая управление торрентами, покрыта тестами (≥ 90 % строк, храповик в CI); очередь и движок переживают падения, отмену и отказ пиров.
2. **Скорость** — MusicBrainz и торренты работают настолько быстро, насколько позволяют внешние сервисы: параллельно, без искусственных пауз, без повторных походов в сеть.
3. **Управление загрузками** — видно, что ещё не найдено и не скачано; поиск повторяется автоматически и по кнопке; альбом можно скачать на сервер целиком.
4. **Настоящее приложение на клиенте** — SPA/PWA, которое грузит всю библиотеку, хранит её локально, мгновенно переключает экраны и умеет скачивать треки на устройство.
5. **Единый аккуратный дизайн** на всех экранах, включая настройки.
6. **Сборка фронтенда на bun.**
7. **Нативные оболочки** — тот же клиент на iOS, Android, macOS, Windows и Linux; нативный звук (фон, экран блокировки, gapless) и офлайн-хранилище. Делается **после** того, как PWA доведена до конца (фаза 4); до этого клиент только соблюдает платформенные границы (см. «Сквозные контракты»).

---

## Как работать («запусти следующий шаг»)

Каждый шаг — отдельный самодостаточный файл `docs/roadmap/NN-*.md`, рассчитанный на выполнение
**от начала до конца за одну сессию** без дополнительных вопросов. Один запрос = один шаг.

Протокол:

1. Открой таблицу «Статус шагов». Если есть шаг `[~]` — продолжай его (прочитай его записи в Журнале).
   Иначе возьми **первый** шаг `[ ]`, у которого все зависимости `[x]`.
2. Прочитай целиком: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md), файл шага, три последние записи Журнала.
   Если шаг ссылается на находки (`J1`, `T2`…) — они в [`docs/architecture-review.md`](docs/architecture-review.md).
3. Поставь шагу `[~]`.
4. Перед кодом прочитай файлы из раздела «Текущее состояние» шага — план писался по коду на момент ревью,
   предыдущие шаги могли его изменить. Расхождения решай в пользу контрактов шага; заметное — в Журнал.
5. Выполни все пункты «Что сделать» и напиши все тесты из раздела «Тесты».
6. Прогони все команды из «Критерии приёмки». Шаг не закрыт, пока они не проходят.
7. **Ревью** по `docs/DEVELOPMENT.md` §7: полный просмотр диффа, чек-лист, исправления, повторный прогон тестов.
8. Поставь `[x]`, добавь запись в Журнал (формат ниже), обнови порог покрытия, если он вырос.
9. Коммит `step NN: <кратко>`. Не пушь, если пользователь не просил.
10. Остановись и отчитайся: что сделано, цифры (покрытие, время, размер бандла — что применимо), что важно для следующего шага.
    **Не начинай следующий шаг.**

Если шаг заблокирован (нет сети, не ставится зависимость): сделай всё возможное (моки, фикстуры,
`#[ignore]`-тесты), оставь `[~]`, запиши в Журнал `БЛОК: <причина и что нужно от человека>`, сообщи пользователю.

Если шаг оказался слишком большим для одной сессии: доведи до состояния, в котором `just check && just test`
зелёные, оставь `[~]` и запиши в Журнал точный список оставшегося. Следующий запрос продолжит его.

---

## Статус шагов

Легенда: `[ ]` не начат · `[~]` в работе · `[x]` готов

### Фаза 0 — правила и измерения

| # | Статус | Шаг | Зависит от |
|---|---|---|---|
| 25 | [x] | [Качество: линты, покрытие, храповик в CI](docs/roadmap/25-quality-gates.md) | — |

### Фаза 1 — бэкенд: надёжность, скорость, управление загрузками

| # | Статус | Шаг | Зависит от |
|---|---|---|---|
| 26 | [x] | [Очередь задач: heartbeat, восстановление, приоритеты, исчерпание попыток](docs/roadmap/26-jobs-reliability.md) | 25 |
| 27 | [x] | [Торрент-движок: блокировки, жизненный цикл, полное покрытие](docs/roadmap/27-torrent-engine-hardening.md) | 25 |
| 28 | [x] | [Быстрые метаданные: `.torrent` в БД, параллелизм, мгновенный старт](docs/roadmap/28-torrent-metadata-fast.md) | 26, 27 |
| 29 | [ ] | [Конвейер поиска без пауз: потоковый импорт, лимитеры, предохранители](docs/roadmap/29-discover-pipeline-speed.md) | 26, 28 |
| 30 | [ ] | [MusicBrainz: пачки, burst, настраиваемый endpoint](docs/roadmap/30-musicbrainz-speed.md) | 26, 29 |
| 31 | [ ] | [Стриминг: таймауты простоя, секрет внутреннего эндпоинта, супервизор](docs/roadmap/31-streaming-robustness.md) | 27, 28 |
| 32 | [ ] | [Состояние приобретения альбомов, массовый и автоматический повтор поиска](docs/roadmap/32-acquisition-backend.md) | 29 |
| 33 | [ ] | [Скачивание альбомов на сервер: закрепление, очередь, пауза](docs/roadmap/33-album-downloads-backend.md) | 31, 32 |
| 34 | [ ] | [API синхронизации: снимок, дельта, сессия](docs/roadmap/34-sync-api.md) | 25 |
| 35 | [ ] | [Закрытие покрытия бэкенда до цели, property-тесты, отказоустойчивость](docs/roadmap/35-backend-coverage-hardening.md) | 26–34 |

### Фаза 2 — клиент: local-first SPA на bun

| # | Статус | Шаг | Зависит от |
|---|---|---|---|
| 36 | [ ] | [Каркас `client/`: Vite + React + bun, токены дизайна, тестовая инфраструктура](docs/roadmap/36-client-scaffold.md) | 25 |
| 37 | [ ] | [Локальные данные: IndexedDB, store, движок синхронизации](docs/roadmap/37-client-data-sync.md) | 34, 36 |
| 38 | [ ] | [Оболочка: вход, навигация, live-соединение, темы, язык](docs/roadmap/38-client-shell-auth.md) | 37 |
| 39 | [ ] | [Экраны библиотеки: главная, библиотека, артист, альбом](docs/roadmap/39-client-library.md) | 38 |
| 40 | [ ] | [Поиск, командная палитра, добавление в библиотеку](docs/roadmap/40-client-search.md) | 39 |
| 41 | [ ] | [Плеер: движок, панель, очередь, полноэкранный режим](docs/roadmap/41-client-player.md) | 39 |
| 42 | [ ] | [Плейлисты и источники треков](docs/roadmap/42-client-playlists-sources.md) | 41 |
| 43 | [ ] | [Дизайн-система форм и новые настройки](docs/roadmap/43-client-design-system-settings.md) | 38 |
| 44 | [ ] | [Экран «Загрузки»: не скачанные альбомы, повтор поиска, торренты](docs/roadmap/44-client-acquisition-ui.md) | 33, 42, 43 |
| 45 | [ ] | [PWA: service worker, офлайн-оболочка, обновления](docs/roadmap/45-client-pwa.md) | 41 |
| 46 | [ ] | [Офлайн-треки: хранилище OPFS, очередь скачивания, воспроизведение без сети](docs/roadmap/46-offline-engine.md) | 45 |
| 47 | [ ] | [Офлайн-треки: интерфейс и управление местом](docs/roadmap/47-offline-ui.md) | 43, 46 |

### Фаза 3 — переключение и доводка

| # | Статус | Шаг | Зависит от |
|---|---|---|---|
| 48 | [ ] | [Переключение: бэкенд раздаёт SPA, сборка на bun, удаление `web/`](docs/roadmap/48-cutover.md) | 40, 42, 44, 47 |
| 49 | [ ] | [Аудит интерфейса: все экраны, темы, размеры, доступность, производительность](docs/roadmap/49-ui-polish-audit.md) | 48 |
| 50 | [ ] | [Мобильная PWA: ощущение нативного и надёжность на iOS и Android](docs/roadmap/50-mobile-pwa.md) | 49 |
| 51 | [ ] | [Финал PWA: сквозные сценарии, нагрузка, документация](docs/roadmap/51-release-hardening.md) | 35, 49, 50 |

### Фаза 4 — нативные оболочки (тот же клиент)

| # | Статус | Шаг | Зависит от |
|---|---|---|---|
| 52 | [ ] | [Подготовка: адрес сервера, токен вместо cookie, CORS, подписанные ссылки на поток](docs/roadmap/52-native-prep.md) | 51 |
| 53 | [ ] | [Оболочка iOS и Android (Capacitor) и нативный плеер](docs/roadmap/53-mobile-shell-audio.md) | 52 |
| 54 | [ ] | [Нативное офлайн-хранилище и фоновые загрузки (iOS, Android)](docs/roadmap/54-mobile-offline.md) | 53 |
| 55 | [ ] | [Настольная оболочка (Tauri 2): macOS, Windows, Linux](docs/roadmap/55-desktop-shell.md) | 52 |

**Контрольные точки:**

- после 35 — бэкенд соответствует целям 1–3 (можно пользоваться со старым `web/`, новые возможности — через API);
- после 44 — новый клиент функционально равен старому и умеет больше;
- после 48 — старый фронтенд удалён, один контейнер приложения;
- после 51 — PWA rock solid, цели 1–6 достигнуты (версия 1.0.0);
- после 55 — цель 7: приложения для iOS, Android, macOS, Windows, Linux.

---

## Сквозные контракты (обязательны для всех шагов)

Шаги вводят и используют общие сущности. Имена ниже — окончательные; менять только с обновлением всех шагов-потребителей.

### Настройки (`Settings`, JSON в таблице `settings`)

| Раздел | Поле | По умолчанию | Вводит шаг |
|---|---|---|---|
| `performance` | `discover_workers` | 8 | 26 |
| `performance` | `verify_workers` | 16 | 26 |
| `performance` | `import_workers` | 2 | 26 |
| `performance` | `metadata_concurrency` | 16 | 28 |
| `performance` | `metadata_timeout_secs` | 30 | 28 |
| `performance` | `download_concurrency` (торрентов одновременно) | 4 | 33 |
| `musicbrainz` | `base_url` | `https://musicbrainz.org/ws/2/` | 30 |
| `musicbrainz` | `rate_per_sec` | 1.0 | 30 |
| `musicbrainz` | `burst` | 3 | 30 |
| `musicbrainz` | `max_concurrent` | 2 | 30 |
| `search` | `auto_retry` | `true` | 32 |
| `storage` | `auto_download` (`off` \| `added`) | `off` | 33 |

### Новые эндпоинты

| Эндпоинт | Шаг |
|---|---|
| `GET /api/jobs`, `POST /api/jobs/{id}/retry` | 26 |
| `GET /api/acquisition`, `GET /api/acquisition/summary`, `POST /api/acquisition/retry` | 32 |
| `POST|DELETE /api/albums/{id}/download`, `POST|DELETE /api/tracks/{id}/download`, `POST /api/downloads/pause-all`, `POST /api/downloads/resume-all` | 33 |
| `GET /api/sync/snapshot`, `GET /api/sync/changes`, `GET /api/auth/session` | 34 |
| `POST /api/tracks/{id}/stream-url`, `GET /api/tracks/{id}/stream?st=`, `api_version` в `GET /api/health` | 52 |

### События WebSocket

Существующие: `track.status`, `job.progress`, `stream.progress`, `library.changed`, `resync`.
Новые: `acquisition.changed { album_id }` (шаг 32), `download.progress { album_id, bytes_done, bytes_total, down_bps, peers }` (шаг 33),
`sync.poke {}` (шаг 34; «есть изменения — подтяни дельту»).

### Миграции БД

Файлы `backend/migrations/NNNN_*.sql` нумеруются по порядку выполнения шагов: шаг берёт **следующий свободный номер**
(ожидаемые: 26 → `0007`, 28 → `0008`, 32 → `0009`, 33 → `0010`, 34 → `0011`; шаги 52–55 миграций не требуют). Если номер в файле шага уже занят — взять следующий и записать в Журнал.

### Платформенные границы клиента

Клиент один для PWA (фазы 2–3) и нативных оболочек (фаза 4). Всё платформенное — только за этими интерфейсами (правило — `docs/DEVELOPMENT.md` §5):

| Граница | Модуль | Вводит | PWA | iOS/Android (53–54) | Desktop (55) |
|---|---|---|---|---|---|
| `platform()`, `apiUrl`, `wsUrl`, `authHeaders`, `SecretStore` | `src/lib/platform` | 36, 52 | тот же origin, cookie | адрес сервера, Bearer, Keychain/Keystore | адрес сервера, Bearer |
| `AudioEngine` | `src/lib/player/audio` | 41 | `<audio>` + Media Session | нативный плеер (AVQueuePlayer / Media3) | `<audio>` + системные медиаконтролы |
| `OfflineStorage`, `Downloader` | `src/lib/offline` | 46 | OPFS + Web Worker | файлы приложения + фоновые загрузки ОС | файлы приложения + загрузчик на Rust |
| `lifecycle`, `haptics` | `src/lib/platform` | 50 | события страницы, `vibrate` | `@capacitor/app`, `@capacitor/haptics` | события окна |

Меняешь интерфейс — обнови файлы шагов фазы 4, которые его реализуют.

### Каталоги

- `backend/` — как сейчас. `client/` — новый фронтенд (шаг 36). `web/` — старый фронтенд, **не развивается**, удаляется на шаге 48. `mobile/` — оболочка Capacitor (шаг 53), `desktop/` — оболочка Tauri (шаг 55).
- Пока `web/` жив, шаги фазы 1 обязаны сохранять его работоспособность: существующие эндпоинты и поля DTO
  не удаляются и не меняют смысл (только добавления); `just web-check` и перегенерация `web/openapi.json` остаются в приёмке.

---

## Журнал

<!-- Новые записи добавлять сверху. Формат:
### YYYY-MM-DD — шаг NN
- Сделано: ...
- Отклонения: ... (что сделано иначе, чем в файле шага, и почему)
- Цифры: покрытие бэкенда X % (порог Y), клиента Z %; прочие измерения шага
- Ревью: ... (что нашлось и исправлено)
- Замечено: ... (постороннее, что стоит сделать позже)
- Важно для следующих шагов: ...
-->

### 2026-11-14 — шаг 28
- Сделано: миграция `0008_torrent_file.sql` (`torrents.torrent_file BYTEA`); `Torrent.has_torrent_file`, колонки перечислены явно (макрос `torrent_cols!`), `torrents::{set_torrent_file, torrent_file, fill_torrent_file_by_hash}`, лимит 8 МБ (`MAX_TORRENT_FILE_BYTES` в core); `nimbus-torrent`: `TorrentRef`, `TorrentMeta.torrent_file`, `parse_torrent_file(bytes, expected)`, `fetch_metadata` отдаёт байты, `ensure_file(s)` принимает `&TorrentRef` (по байтам — без сети, трекеры из magnet/публичные в опциях; чужой/битый файл отклоняется до слота), `FileProvider::torrent_file(id)`, `session_torrent_files()`, публичные трекеры дописываются к magnet без `tr=` (для приватных `.torrent` — нет), DHT-таблица в `{session}/dht.json`, `metadata_concurrency`/`public_trackers` в `EngineConfig`; `verify::load_files` — из `.torrent` без сети, иначе сеть + сохранение; расписание повторов 1/5/30 мин; стрим/prefetch/transcode/CUE собирают `TorrentRef` из БД и сохраняют байты движка (`worker::torrent_file`); Torznab кладёт скачанный `.torrent` в `TorrentCandidate.torrent_file`, `discover::store` сохраняет и сразу заполняет файлы (`meta_status = ok`); `performance.metadata_concurrency` (16, 1–64) и `metadata_timeout_secs` (30, 5–300); фоновое дозаполнение из сессии при старте; `testkit::torrent_file`; docs/architecture.md, docs/api.md.
- Отклонения: (1) шаг противоречив: «1/5/30 мин» и «третья неудача → dead». Принято: три повтора (1, 5, 30 мин), `MAX_META_ATTEMPTS = 4`, четвёртая неудача → `dead` (укладывается в 5 попыток задачи). (2) Публичные трекеры добавляются через `EngineConfig.public_trackers` (из `nimbus_trackers::PUBLIC_TRACKERS` в `main.rs`), а не зависимостью torrent → trackers. (3) `TorrentCandidate` получил ручной `Debug` (в логи — только размер файла). (4) Старый таймаут по умолчанию 45 с → 30 с.
- Цифры: покрытие 91.05 % строк (порог 88 → 90); `torrent/src/lib.rs` 92.35 %, `verify.rs` 95.5 %, `discover.rs` 97.7 %, `torrent_file.rs` 97.1 %, `cue.rs` 85 %. Локальный рой, `ensure_file` → первый байт стрима: по magnet ≈ 57 мс, с `.torrent` ≈ 14 мс (в реальной сети разница — секунды DHT); без сидера по байтам `ensure_file` проходит мгновенно, по magnet — `MetadataTimeout`.
- Ревью: дифф просмотрен; `just check` чисто (предупреждение web `library.spec.ts:161` старое). Найдено и исправлено: утечка слота при отклонении битого `.torrent` (проверка вынесена до слота), тесты с одним и тем же торрентом в цикле (переписаны). OpenAPI не менялся (настройки — `Object`).
- Замечено: (а) сохранение DHT в `dht.json` проверить тестом не удалось (в изолированной среде файл не появился за 10 с; конфигурация передана, нужна проверка на живой сети). (б) Дозаполнение из сессии (п. 9) покрыто тестом репозитория/функции, но не интеграционно с живым движком. (в) `cue.rs` 85 % — ветки ошибок закроет шаг 35. (г) Postgres из docker один раз упал на первом прогоне (как в записях 25–27).
- Важно для следующих шагов: `FileProvider::ensure_file(s)` теперь принимает `&TorrentRef`; новые фейки обязаны его учитывать. Шаг 29 может опираться на то, что у Torznab-раздач список файлов известен сразу после discover. Следующая миграция — `0009`.

### 2026-11-14 — шаг 27
- Сделано: `TorrentEngine` на слотах уровня торрента (`state` — std-мьютекс карты, не держится через `.await`; `TorrentSlot { op, selected, pause_task }`), операции над разными торрентами независимы, ожидание `op` ограничено `metadata_timeout`; `ensure_files` (один `update_only_files` на набор; `ensure_file` выражен через него; метод добавлен в `FileProvider` с реализацией по умолчанию); очистка после неудачного добавления (торрент и слот удаляются); фоновые задачи в `TaskTracker` + `CancellationToken` (один ratio-watcher, не более одной «паузы по завершении» на торрент), идемпотентный `shutdown()`; `EngineError::Storage` (+ ответ API `507 storage_error`), неверный индекс у нового торрента → `InvalidFileIndex`; перезапуск торрента из `Error` (`unpause`, затем `delete` + повторное добавление); `NIMBUS_TORRENT_PORT` (по умолчанию 6881, занятый порт → случайный; `.env.example`, `README.md`, `docker-compose.yml` пробрасывает тот же порт); `ratio_check_interval` в `EngineConfig`; схема блокировок в шапке `lib.rs`. `fake_swarm`: `deaf_magnet`, `blackhole`, `FakeSwarm::stop`; `tests/swarm.rs` переписан на общий `fake_swarm` и `nimbus-testkit` (29 тестов вместо 10).
- Отклонения: (1) торрент-крейт подключает собственную фичу `test-fakes` как dev-зависимость на самого себя — тесты роя идут и под обычным `cargo test`. (2) «Глухой» торрент висит до таймаута только с пиром-«чёрной дырой» в `initial_peers` (иначе librqbit сразу сдаётся) — для этого `fake_swarm::blackhole`. (3) Добавлены диагностические `tracked_torrents()` и `background_tasks()`. (4) Ошибки `os error …` из librqbit при добавлении трактуются как `Storage`. (5) Пустой набор в `ensure_files` — `Internal("no files requested")`. (6) Фоновые проходы по торрентам (политика раздачи, ratio-watcher) ждут `op` слота не дольше 5 с и пропускают занятый торрент.
- Цифры: покрытие бэкенда 90.86 % строк (порог 88, не менялся); крейт `torrent` (без `fake_swarm`) 92.35 % строк; `cargo test -p nimbus-torrent` 5 прогонов подряд без падений (~6 с каждый).
- Ревью: дифф просмотрен; поправлено по ходу — порядок файлов в торренте не совпадает с порядком создания (librqbit обходит каталог как есть), тесты сопоставляют индексы по имени (`ix`), иначе они флакали бы; `unwrap`/`dbg!`/`println!` в боевом коде нет.
- Замечено: (а) ветка перезапуска из `Error` (`recover_errored`) не покрыта интеграционным тестом — состояние `Error` не удалось вызвать искусственно в локальном рое. (б) `Session::stop` в librqbit спит 1 с, поэтому `shutdown` всегда ≥ 1 с. (в) Инкрементальный кэш rustc испортился после прерванной сборки (ICE в clippy) — лечится `rm -rf backend/target/debug/incremental`. (г) Postgres из docker-compose по-прежнему может падать на первом тестовом прогоне после пересборки (см. записи шагов 25–26).
- Важно для следующих шагов: шаг 28 (метаданные без второй загрузки) может опираться на `fetch_metadata` быстрого пути «торрент уже в сессии»; шаг 33 использует `ensure_files`; общие помощники роя — `nimbus_torrent::fake_swarm` (`deaf_magnet`, `blackhole`, `stop`) и `nimbus-testkit`.

### 2026-11-13 — шаг 26
- Сделано: миграция `0007_jobs_reliability.sql` (`priority`, `heartbeat_at`, индекс `jobs_claim_idx`); приоритеты `PRIORITY_INTERACTIVE/NORMAL/BACKGROUND` и `EnqueueOpts` (повторная постановка с большим приоритетом поднимает ожидающую задачу), `defer_queued_verifies` → `demote_queued_verifies`, `LOW_PRIORITY_DELAY` удалён; heartbeat (15 с) и `stale_after` 90 с; `WorkerPool::start` (восстановление сирот + запуск), `JobCtx.cancel`/`ctx.run()`/`JobError::Cancelled`, остановка с `abort` по таймауту и возвратом строк в `queued`; хук `on_exhausted` (verify, discover_album, process_cue, import_artist; для потерянных воркером задач — из обслуживающего цикла) и `NotFoundReason::SearchFailed`; `settings.performance` (воркеры 1–64, `restart_required`), пул БД `10 + воркеры` (мин. 20, `acquire_timeout` 30 с); `GET /api/jobs`, `POST /api/jobs/{id}/retry`; OpenAPI, типы `web/`, `docs/api.md`, `docs/architecture.md`.
- Отклонения: (1) добавлен второй хук `JobHandler::on_retry` (вызывается после записи запланированного повтора) — им import_artist публикует `library.changed`, как раньше делал раннер; публикация из `handle` шла бы до записи состояния. (2) `enqueue_with_attempts` удалён, `max_attempts` — поле `EnqueueOpts`. (3) `restart_required` сравнивает с параллелизмом, с которым запущен процесс (`AppState.boot_performance`), а не с предыдущим сохранением — иначе флаг сбрасывался бы следующим же PUT. (4) `on_exhausted` пробуется до 3 раз (пауза 0,5 с) — единичная ошибка БД не должна оставлять альбом в `adding`. (5) Пул БД: стартовый пул (20) для миграций и чтения настроек, затем рабочий нужного размера. (6) В `process_cue` логика «отдать кандидата» переехала из `handle` в `on_exhausted`; тест `unusable_cue_is_fatal…` вызывает хук явно.
- Цифры: покрытие бэкенда 89.69 % строк (порог 88, без изменения: floor−1); `db/src/repo/jobs.rs` 98.1 %, `api/src/jobs.rs` 100 % по строкам; новых тестов ~45 (db 11, worker 14, api 9, core 2, прочие). `worker/src/runner.rs` 82 % — оставшееся (ошибочные ветки listen_loop и т. п.) закроет шаг 35.
- Ревью: code-review (medium) + ручной просмотр. Исправлено: порядок события import (→ `on_retry`), потеря очистки при ошибке хука (повторы), `restart_required`. Принято осознанно и записано ниже: возврат попытки при старте (контракт шага), отсутствие защиты `complete/fail` по `locked_by`, нет немедленного запуска при повышении приоритета будущей задачи, `retry` не откатывает доменное состояние, фоновые verify больше не задерживаются по времени.
- Замечено: (а) `recover_orphans` возвращает попытку всем `running`: «ядовитая» задача, роняющая процесс, после рестарта не исчерпает попытки и может крутить crash-loop — потребуется счётчик запусков без штатной остановки (идея для шага 35). (б) `complete`/`fail`/`release` обновляют по `id` без проверки `locked_by`: при простое >90 с воркер, потерявший задачу, может перезаписать чужой claim; нужно `WHERE locked_by = $worker`. (в) `POST /api/jobs/{id}/retry` для `discover_album` не возвращает треки из `not_found/search_failed` в `adding` — полноценный повтор поиска делает шаг 32. (г) Постановка с бо́льшим приоритетом не сдвигает `run_after` будущей (backoff) задачи. (д) `demote_queued_verifies` понижает и интерактивные verify альбома; фильтр `payload->>'album_id'` без индекса. (е) Postgres из docker-compose падает («server process exited with exit code 2», без причины в логе) на старте первого `cargo test --workspace` после пересборки — теперь 4 раза за шаги 25–26, лечится повторным запуском; причина не найдена. (ж) `web/tests/library.spec.ts:161` — предупреждение sort-keys.
- Важно для следующих шагов: задачи, порождающие задачи, наследуют `ctx.priority`; новые обработчики обязаны оборачивать ожидания сети в `ctx.run(...)` и при необходимости реализовать `on_exhausted`/`on_retry`; в `Settings` появился раздел `performance` (шаги 28 и 33 добавляют в него `metadata_concurrency`, `metadata_timeout_secs`, `download_concurrency`); следующая миграция — `0008`. Шаг 29 удаляет `ALBUM_JOB_STAGGER`/`VERIFY_STAGGER`.

### 2026-11-13 — шаг 25
- Сделано: `[workspace.lints]` (`unsafe_code = forbid`; `unwrap_used`, `dbg_macro`, `todo`, `unimplemented`, `print_*` = deny) + `[lints] workspace = true` во всех крейтах, `backend/clippy.toml`; три боевых `lock().unwrap()` (musicbrainz) → `unwrap_or_else(PoisonError::into_inner)`; `println!` в `main.rs` помечен `#[allow]`. Рецепты `backend-cov`, `backend-cov-html`, `cov`; `backend/coverage-threshold.txt`; CI считает покрытие вместо отдельного `cargo test` и пишет сводку в `$GITHUB_STEP_SUMMARY`; `docs/coverage.md`; крейт `nimbus-testkit` (`eventually`, `tempdir`, 3 теста), на него переведены 3 цикла ожидания (`api/tests/stream.rs` ×2, `downloads.rs`) и `wait_state` в `worker/tests/runner.rs`.
- Отклонения: (1) в `tests/*.rs` добавлен `#![allow(clippy::unwrap_used)]` — `allow-unwrap-in-tests` не распространяется на вспомогательные функции интеграционных тестов. (2) `backend-check` в `justfile` теперь с `--features nimbus-api/test-fakes`, как в CI. (3) Тест `post_artist_is_accepted_and_import_job_adds_discography` падал ещё до шага (коммит 7c7cbbd сделал «только альбомы» значением по умолчанию, EP пропускается) — ожидания обновлены (1 альбом, 4 трека). (4) `testkit` входит в отчёт покрытия (43 строки, 97.7 %).
- Цифры: покрытие бэкенда 89.38 % строк (порог 88); слабые места — `torrent` 73.1 %, `api` 82.4 %, `api/src/artist_image.rs` 0 %; полный список — `docs/coverage.md`.
- Ревью: дифф просмотрен целиком, `just check` и `just cov` зелёные, OpenAPI не менялся. Замечаний нет.
- Замечено: при первых прогонах `cargo test --workspace` Postgres из docker-compose (порт 5433) трижды падал («server process exited with exit code 2», recovery) прямо на старте тестов `api/tests/auth.rs`; на чистом `HEAD` и при последующих прогонах не воспроизвелось — причина не найдена, следить. `web/tests/library.spec.ts:161` — предупреждение линтера sort-keys (не относится к шагу).
- Важно для следующих шагов: `cargo-llvm-cov` и `llvm-tools-preview` нужно ставить локально (`just cov`). Общие фейки класть в `crates/testkit`; для ожиданий использовать `nimbus_testkit::eventually`. Порог повышать только вверх.

### 2026-11-13 — план: нативные оболочки (фаза 4)
- Сделано: решение по клиентам — один React-клиент; сначала PWA доводится до конца, затем тонкие нативные оболочки: Capacitor для iOS/Android, Tauri 2 для desktop. Добавлены шаг 50 (мобильная PWA на устройствах), фаза 4 (шаги 52–55); прежний шаг 50 «Финал» стал шагом 51.
- Важно для следующих шагов: платформенные границы вводятся сразу — `src/lib/platform` (36), `AudioEngine` (41), `OfflineStorage`/`Downloader` (46); см. «Сквозные контракты → Платформенные границы клиента». PWA-шаги реализуют только веб-версии, но не протаскивают `<audio>`/OPFS/`'/api/…'` мимо интерфейсов.

### 2026-11-13 — составлена дорожная карта
- Сделано: ревью архитектуры (`docs/architecture-review.md`), правила разработки (`docs/DEVELOPMENT.md`), шаги 25–50 (`docs/roadmap/`).
- Решение по офлайну: аудио играет из OPFS через объектный URL, без перехвата потока в service worker (проще и надёжнее на iOS) — см. шаг 46.
- Важно для следующих шагов: опциональный шаг 24 старого плана (зеркало MusicBrainz) поглощён шагом 30 (настраиваемый endpoint).
