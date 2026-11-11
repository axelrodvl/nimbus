// Форма настроек, которую отдаёт `GET /api/settings` (секреты заменены маской).
export const SECRET_MASK = '••••';

export type Settings = {
  providers: {
    tpb_enabled: boolean;
    torznab: { url: string; api_key: string | null } | null;
    rutracker: {
      username: string | null;
      password: string | null;
      cookie: string | null;
      proxy: string | null;
      music_forums_regex: string | null;
    } | null;
  };
  search: { max_candidates: number; format_prefs: string[]; skip_secondary_types: string[] };
  matching: { accept: number; confirm: number };
  playback: { transcode_alac: boolean; transcode_lossy_codec: 'opus' | 'mp3'; prefetch_next: boolean };
  storage: { cache_limit_gb: number; seeding: boolean; seed_ratio: number | null };
};

export type Storage = { used_bytes: number; limit_bytes: number; files: number; torrents_active: number };

// Названия форматов; `mp3_other` переводится (ключ `format.mp3_other`).
export const FORMAT_LABELS: Record<string, string> = {
  aac: 'AAC',
  alac: 'ALAC',
  ape_wv: 'APE / WavPack',
  flac: 'FLAC',
  mp3_320: 'MP3 320',
  mp3_v0: 'MP3 V0',
};
