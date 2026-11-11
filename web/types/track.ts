import type { TrackStatus } from '@/lib/api/events';

// Модель трека на стороне UI. Шаги 09–11 заполняют её из ответов API (поиск, библиотека).
export type Track = {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  /** Для ссылок из плеера на страницы альбома и артиста. */
  albumId?: number;
  artistId?: number;
  durationMs: number | null;
  coverUrl: string | null;
  status: TrackStatus;
  /** `transcode` — образ CUE или формат вне браузера: поток без Range, перемотка через `?t=`. */
  playback?: 'direct' | 'transcode';
};
