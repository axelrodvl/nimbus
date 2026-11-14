import { isOnlineNow } from '@/lib/live/online';
import { offline } from '@/lib/offline';
import type { TrackStatus, TrackView } from '@/lib/store/selectors';

/**
 * Трек в очереди плеера: снимок для показа и сохранения. Актуальные статус и существование трека
 * контроллер читает из библиотечного store в момент использования (`PlayerDeps.getTrack`).
 */
export type PlayerTrack = {
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

/** Трек библиотеки → трек плеера. */
export function toPlayerTrack(t: TrackView): PlayerTrack {
  return {
    album: t.albumTitle || null,
    albumId: t.album_id,
    artist: t.artistName,
    artistId: t.artist_id,
    coverUrl: t.coverUrl,
    durationMs: t.duration_ms ?? null,
    id: t.id,
    playback: t.playback === 'transcode' ? 'transcode' : 'direct',
    status: t.status,
    title: t.title,
  };
}

/**
 * Можно ли играть трек сейчас: он скачан на устройство **или** есть связь с сервером и трек готов к выдаче
 * (`found`/`ready`). Единая функция для контроллера и кнопок; `id` нужен, чтобы увидеть скачанный файл.
 */
export const canPlay = (t: { id?: number; status: TrackStatus }): boolean =>
  (t.id !== undefined && offline().playback.has(t.id)) || ((t.status === 'found' || t.status === 'ready') && isOnlineNow());

export const isTranscoded = (t: Pick<PlayerTrack, 'playback'> | null | undefined): boolean =>
  t?.playback === 'transcode';
