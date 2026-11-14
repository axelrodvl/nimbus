import { authHeaders } from '@/lib/platform/auth-transport';
import { streamUrl } from '@/lib/platform/urls';
import type { AudioSource } from './audio/types';
import { isTranscoded, type PlayerTrack } from './track';

/**
 * Единственное место, где строится источник потока трека: `GET /api/tracks/{id}/stream[?t=<сек>]` + заголовки
 * авторизации платформы. Для перекодируемых треков (`transcode`) `startSeconds` — смещение внутри трека (`?t=`).
 * Возвращает значение синхронно (жест iOS); шаг 46 подменит функцию для офлайн-треков.
 */
export function resolveStreamUrl(track: PlayerTrack, startSeconds: number): AudioSource {
  return {
    headers: authHeaders(),
    mode: isTranscoded(track) ? 'transcode' : 'direct',
    url: streamUrl(track.id, startSeconds),
  };
}
