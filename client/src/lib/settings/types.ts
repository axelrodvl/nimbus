/** Маска, которой сервер заменяет заданные секреты. Назад как значение её отправлять нельзя. */
export const SECRET_MASK = '••••';

/** Порядок форматов по умолчанию на сервере (`FORMAT_KEYS`). */
export const FORMAT_KEYS = ['flac', 'alac', 'mp3_320', 'mp3_v0', 'aac', 'ape_wv', 'mp3_other'] as const;

/** Типы релизов MusicBrainz, которые можно импортировать с артистом (в порядке показа). */
export const RELEASE_TYPES = [
  'Album',
  'EP',
  'Compilation',
  'Live',
  'Remix',
  'DJ-mix',
  'Demo',
  'Soundtrack',
  'Mixtape/Street',
  'Spokenword',
  'Interview',
  'Audiobook',
  'Audio drama',
] as const;

export const PUBLIC_MB_BASE = 'https://musicbrainz.org/ws/2/';

/** Допустимые диапазоны и значения по умолчанию — зеркало валидации сервера (`core/src/settings.rs`). */
export const PERFORMANCE_FIELDS = [
  { def: 8, key: 'discover_workers', max: 64, min: 1 },
  { def: 16, key: 'verify_workers', max: 64, min: 1 },
  { def: 2, key: 'import_workers', max: 64, min: 1 },
  { def: 16, key: 'metadata_concurrency', max: 64, min: 1 },
  { def: 30, key: 'metadata_timeout_secs', max: 300, min: 5 },
  { def: 4, key: 'download_concurrency', max: 32, min: 1 },
] as const;

export type Providers = {
  tpb_enabled?: boolean;
  torznab?: { url?: string; api_key?: string | null } | null;
  rutracker?: {
    username?: string | null;
    password?: string | null;
    cookie?: string | null;
    proxy?: string | null;
    user_agent?: string | null;
    headers?: string | null;
  } | null;
};

/**
 * Настройки, как их отдаёт `GET /api/settings`. Схема OpenAPI описывает тело как «объект», поэтому форма
 * задана здесь; все поля необязательны — раздел или поле, которого нет в ответе, интерфейс не показывает.
 */
export type ServerSettings = {
  providers?: Providers;
  search?: { max_candidates?: number; format_prefs?: string[]; skip_secondary_types?: string[]; auto_retry?: boolean };
  matching?: { accept?: number; confirm?: number };
  playback?: { transcode_alac?: boolean; transcode_lossy_codec?: string; prefetch_next?: boolean };
  storage?: { cache_limit_gb?: number; seeding?: boolean; seed_ratio?: number | null; auto_download?: string };
  performance?: Partial<Record<(typeof PERFORMANCE_FIELDS)[number]['key'], number>>;
  musicbrainz?: { base_url?: string; rate_per_sec?: number; burst?: number; max_concurrent?: number };
  /** Только в ответе `PUT`: параллелизм воркеров изменится после перезапуска сервера. */
  restart_required?: boolean;
  /** Только в ответе `PUT`: появился провайдер — стоит повторить поиск ненайденного. */
  suggest_retry_missing?: boolean;
};

export type Patch = Record<string, unknown>;
