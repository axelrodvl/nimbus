# Покрытие бэкенда

Инструмент: `cargo llvm-cov` (`just backend-cov`), строки. Исключены `main.rs`, `fakes.rs`, `fake_swarm.rs`
(сборка зависимостей и тестовые двойники). Цель — см. `docs/DEVELOPMENT.md` §4; порог — `backend/coverage-threshold.txt`.

## Исходная точка (2026-11-13, шаг 25)

| Крейт | Строк | Покрыто | % строк |
|---|---:|---:|---:|
| api | 2865 | 2360 | 82.4 |
| core | 706 | 671 | 95.0 |
| db | 1481 | 1411 | 95.3 |
| library | 321 | 282 | 87.9 |
| matcher | 731 | 720 | 98.5 |
| musicbrainz | 797 | 738 | 92.6 |
| testkit | 43 | 42 | 97.7 |
| torrent | 592 | 433 | 73.1 |
| trackers | 1205 | 1153 | 95.7 |
| worker | 1148 | 1029 | 89.6 |
| **workspace** | 9889 | 8839 | **89.4** |

## 15 файлов с наименьшим покрытием

| Файл | Непокрыто строк | % строк |
|---|---:|---:|
| `torrent/src/lib.rs` | 159 | 73.1 |
| `api/src/artist_image.rs` | 135 | 0.0 |
| `api/src/stream.rs` | 80 | 87.4 |
| `api/src/audio_info.rs` | 66 | 55.4 |
| `api/src/transcode.rs` | 60 | 70.4 |
| `worker/src/runner.rs` | 57 | 79.2 |
| `musicbrainz/src/client.rs` | 49 | 89.0 |
| `library/src/service.rs` | 39 | 87.7 |
| `api/src/settings.rs` | 32 | 74.2 |
| `api/src/sources.rs` | 30 | 92.0 |
| `trackers/src/rutracker.rs` | 29 | 90.2 |
| `api/src/routes.rs` | 28 | 83.4 |
| `worker/src/cue.rs` | 26 | 84.0 |
| `api/src/library.rs` | 26 | 92.0 |
| `db/src/repo/views.rs` | 22 | 87.4 |

## Шаг 35 (2026-11-14, промежуточный замер; шаг не закрыт)

Замер `just backend-cov` (JSON-отчёт, один прогон). Проверка порогов по крейтам — `scripts/cov-check.sh`
(bash + `jq`).

| Крейт | Строк | Покрыто | % строк |
|---|---:|---:|---:|
| api | 4459 | 4070 | 91.3 |
| core | 1112 | 1073 | 96.5 |
| db | 2658 | 2570 | 96.7 |
| library | 490 | 454 | 92.7 |
| matcher | 740 | 731 | 98.8 |
| musicbrainz | 1295 | 1244 | 96.1 |
| testkit | 73 | 72 | 98.6 |
| torrent | 1058 | 996 | **94.1** (цель 95) |
| trackers | 1448 | 1397 | 96.5 |
| worker | 1530 | 1454 | 95.0 |
| **workspace** | 14863 | 14061 | **94.6** |

Ключевые файлы: `api/src/stream.rs` 95.5, `db/src/repo/jobs.rs` 98.2, `matcher` 98.8, `worker` 95.0 (запас ~0), `torrent` 94.1.

Файлы ниже 90 %:

| Файл | Непокрыто строк | % строк |
|---|---:|---:|
| `api/src/artist_image.rs` | 135 | 0.0 |
| `db/src/lib.rs` | 16 | 36.0 |
| `api/src/error.rs` | 11 | 66.7 |
| `api/src/extract.rs` | 3 | 70.0 |
| `api/src/ws.rs` | 11 | 79.6 |
| `api/src/settings.rs` | 33 | 80.9 |
| `trackers/src/types.rs` | 7 | 82.1 |
| `api/src/state.rs` | 12 | 82.4 |
| `api/src/routes.rs` | 28 | 85.9 |
| `db/src/repo/views.rs` | 22 | 87.4 |
| `core/src/config.rs` | 19 | 88.5 |
| `db/src/settings.rs` | 8 | 88.7 |
| `db/src/repo/album_torrents.rs` | 20 | 88.9 |

Непокрытые строки `torrent/src/lib.rs` (63): основная масса — `recover_errored` (торрент в состоянии `Error`: 1070–1107),
журнальные ветки ошибок librqbit (`set_seeding`/`set_seed_ratio`/ratio-watcher: 671, 674, 705, 711, 733, 743, 748),
`for_each_torrent` для занятого слота (1294–1295, 1304, 1306), гонки слота (463, 1218–1219). Состояние `Error`
у восстановленного торрента воспроизвести не удалось: librqbit не добавляет в сессию торрент, чей файл не открывается.
