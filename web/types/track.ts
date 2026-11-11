import type { TrackStatus } from '@/lib/api/events';

// Модель трека на стороне UI. Шаги 09–11 заполняют её из ответов API (поиск, библиотека).
export type Track = {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  coverUrl: string | null;
  status: TrackStatus;
};
