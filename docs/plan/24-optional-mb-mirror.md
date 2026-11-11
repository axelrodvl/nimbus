# Шаг 24 — (Опционально) Локальное зеркало MusicBrainz

**Зависит от:** 23
**Оценка:** 3–5 дней

## Цель

Снять лимит MusicBrainz 1 запрос/сек и сделать поиск мгновенным «по мере ввода»: локальная копия данных MusicBrainz + собственный полнотекстовый индекс. Клиент `musicbrainz` получает второй бэкенд — локальный — с тем же публичным API, переключаемый настройкой.

## Варианты (выбрать один, обосновать в Журнале)

**А. Официальный `musicbrainz-docker`** (https://github.com/metabrainz/musicbrainz-docker) — полная реплика с собственным веб-сервисом `/ws/2` и Solr-поиском. Плюсы: тот же API, код клиента не меняется (только `base_url` и выключенный лимитер). Минусы: ~100+ ГБ диска, 16+ ГБ RAM для Solr, долгий первичный импорт, ежечасная репликация.

**Б. Облегчённый импорт** (рекомендуется для личного сервера): из дампа `mbdump.tar.bz2` (https://data.metabrainz.org/pub/musicbrainz/data/fullexport/) импортировать только таблицы `artist`, `artist_credit`, `artist_credit_name`, `release_group`, `release_group_primary_type`, `release_group_secondary_type(_join)`, `release`, `release_country`, `medium`, `medium_format`, `track`, `recording` в отдельную схему `mb` нашей Postgres, затем построить индекс поиска в **Tantivy** (встроенный в бэкенд) или **Meilisearch** (отдельный контейнер). Обновление — еженедельно новым дампом (или JSON-дампами `/pub/musicbrainz/data/json-dumps/`).

## Что сделать (для варианта Б)

1. Сервис `mb-import` (отдельный бинарник в workspace, `crates/mb-import`): скачать последний дамп, распаковать нужные таблицы (TSV, формат COPY), `COPY` в схему `mb`, создать индексы. Идемпотентно, с заменой схемы атомарно (`mb_new` → rename).
2. Индекс Tantivy в `{data_dir}/mb-index`: три типа документов (artist, release_group, recording) с полями `name/title` (с edge-ngram токенизатором для префиксного поиска), `artist_name`, `aliases`, `year`, `type`, popularity-прокси (число релизов/записей — для ранжирования). Построение — в `mb-import` после импорта.
3. `MbBackend` trait в крейте `musicbrainz` с реализациями `RemoteMb` (текущая) и `LocalMb` (SQL-запросы к схеме `mb` для lookup и Tantivy для поиска). Публичный `MbClient` делегирует выбранному бэкенду; доменные структуры (`ArtistHit`, `ReleaseTracklist`, …) — те же.
4. Настройка `metadata.backend: "remote" | "local"` (шаг 22), автоматический fallback на remote, если локальная база пуста.
5. Поиск при `local`: `/api/search` отвечает < 50 мс → фронтенд уменьшает debounce до 120 мс (бэкенд сообщает режим в `/api/health` или `/api/settings`).
6. `just mb-import` и сервис в compose (запуск по профилю `docker compose --profile mb-import run mb-import`).

## Тесты

- `mb-import` на мини-дампе (сгенерировать фикстуры: несколько артистов/релизов в формате TSV дампа).
- `LocalMb` возвращает те же доменные структуры, что `RemoteMb`, на одинаковых данных (сравнить с фикстурами шага 06).
- Префиксный поиск «radi» находит Radiohead первым.

## Критерии приёмки

- `just test`, `just check` проходят.
- После импорта полного дампа: поиск «radio» отвечает < 100 мс, результаты сопоставимы с musicbrainz.org; добавление альбома работает без обращений к musicbrainz.org.
