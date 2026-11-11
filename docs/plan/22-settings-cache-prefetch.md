# Шаг 22 — Настройки, кэш, prefetch, раздача

**Зависит от:** 20, 21
**Оценка:** 2 дня

## Цель

1. Настройки, редактируемые из UI и хранящиеся в БД (поверх env-дефолтов).
2. Ограничение размера кэша на диске с вытеснением давно не игравших файлов.
3. Предзагрузка следующего трека очереди для бесшовного перехода.
4. Политика раздачи (seeding).

## Что сделать

### 1. Настройки (бэкенд)

Миграция `0004_settings.sql`:
```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
```

Структура (`core::settings::Settings`, serde, `Default` из `Config`):
```rust
pub struct Settings {
    pub providers: ProvidersSettings {
        tpb_enabled: bool,
        torznab: Option<{ url: String, api_key: String }>,
        rutracker: Option<{ username: String, password: Secret, cookie: Option<Secret>, proxy: Option<String>, music_forums_regex: Option<String> }>,
    },
    pub search: { max_candidates: u8 /*8*/, format_prefs: Vec<Format> /*flac, alac, mp3_320, ...*/,
                  skip_secondary_types: Vec<String> /*Compilation, Live, ...*/ },
    pub matching: { accept: f32, confirm: f32 },
    pub playback: { transcode_alac: bool, transcode_lossy_codec: "opus"|"mp3", prefetch_next: bool },
    pub storage: { cache_limit_gb: u64, seeding: bool, seed_ratio: Option<f32> },
}
```
- Хранить как одну запись `key='settings'` (проще) или по разделам — на выбор.
- `SettingsStore` в `AppState`/`JobCtx`: `get() -> Arc<Settings>` (кэш в памяти, `ArcSwap`), `update(patch)`. При изменении провайдеров — пересобрать `ProviderRegistry` (держать его за `ArcSwap`), при изменении `seeding` — применить к движку.
- Секреты (`password`, `cookie`, `api_key`) в `GET` возвращаются замаскированными (`"••••"` / `has_password: true`); `PUT` с пустым значением секрета — не менять.
- Замени константы шагов 10, 14, 16, 21 на чтение из `Settings`.

Эндпоинты:
```
GET  /api/settings                 → SettingsDto (секреты замаскированы)
PUT  /api/settings                 body: частичный SettingsDto (merge) → SettingsDto
POST /api/settings/providers/test  body: { provider: "tpb"|"rutracker"|"torznab" } → { ok, message, sample_count }
                                   (поиск "Radiohead" и отчёт; для rutracker — проверка логина)
GET  /api/storage                  → { used_bytes, limit_bytes, files: i64, torrents_active: i64 }
```

### 2. Вытеснение кэша

Задача `Job::EvictCache` (ставится раз в 10 минут планировщиком внутри `WorkerPool` и после каждого `completed_at`):
1. `used = Σ размер файлов downloads на диске` (по факту `metadata.len()`/занятому месту; учитывать и недокачанные).
2. Если `used > limit` — сортировать `downloads` по `COALESCE(last_played_at, completed_at)` ASC, **исключая** файлы, которые сейчас стримятся (регистр активных стримов из шага 18 — `Arc<DashMap<(torrent,file), count>>`) и prefetch-файлы последних 10 минут.
3. Удалять: `engine.release_file(.., delete_data = true)`, удалить строку `downloads`, треки `ready → found` (+ события), пока `used <= 0.9 * limit`.
4. Пустые каталоги внутри `data/torrents` — удалить.

### 3. Prefetch

- `POST /api/tracks/{id}/prefetch` → `Job::PrefetchTrack { track_id }` (или прямо в хендлере, без очереди — проще и быстрее): `ensure_file` + открыть поток и прочитать первые ~2 МБ (или 10 % файла), затем отпустить поток; файл продолжает качаться в фоне (only_files уже включает его).
- Фронтенд: когда до конца текущего трека остаётся 30 с (или сразу после начала, если `prefetch_next`), вызвать prefetch для следующего в очереди, только если он `found` (не `ready`).
- Дополнительно — предзагрузка `<audio>`: второй скрытый `HTMLAudioElement` с `preload="auto"` для следующего трека и мгновенное переключение по `ended` (gapless-приближение). Если усложняет — достаточно prefetch на бэкенде.

### 4. Раздача

- `seeding = false` (по умолчанию): после завершения файлов торрент ставится на паузу (шаг 15).
- `seeding = true`: торрент продолжает раздавать; при заданном `seed_ratio` — пауза по достижении. Предупреждение в UI: «Раздача означает распространение файлов; для RuTracker повышает рейтинг».

### 5. Фронтенд — страница `/settings`

Разделы: «Источники» (TPB вкл/выкл, Torznab URL+ключ, RuTracker логин/пароль/cookie/прокси, кнопка «Проверить» для каждого с результатом), «Поиск и сопоставление» (порядок форматов — список с перетаскиванием или стрелками, пороги, пропускаемые типы релизов), «Воспроизведение» (prefetch, перекодирование), «Хранилище» (лимит кэша с индикатором использования из `/api/storage`, раздача + предупреждение). Server Functions + `useActionState`, toast об успехе.

## Тесты

- Бэкенд: merge настроек, маскирование секретов, пустой секрет не затирает существующий; пересборка реестра провайдеров после `PUT`; `EvictCache` удаляет самые старые и не трогает активные стримы, треки `ready → found`; prefetch вызывает `ensure_file` и читает начало.
- Фронтенд (Playwright с моками): сохранение настроек отправляет правильный `PUT`, секреты не показываются.

## Критерии приёмки

- `just test`, `just check`, `pnpm build` проходят; типы API обновлены.
- Ручная проверка: выставить лимит кэша 1 ГБ → после прослушивания нескольких альбомов старые файлы удаляются, треки становятся `found`.

## Вне рамок шага

Авторизация (шаг 23).
