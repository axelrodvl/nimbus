import { offline } from '@/lib/offline';
import { authHeaders } from '@/lib/platform/auth-transport';
import { streamUrl } from '@/lib/platform/urls';
import type { AudioSource } from './audio/types';
import { isTranscoded, type PlayerTrack } from './track';

/**
 * Единственное место, где строится источник потока трека: `GET /api/tracks/{id}/stream[?t=<сек>]` + заголовки
 * авторизации платформы. Для перекодируемых треков (`transcode`) `startSeconds` — смещение внутри трека (`?t=`).
 * Для сетевого трека возвращает значение синхронно (жест iOS). Скачанный на устройство трек играет из файла:
 * режим `direct` всегда (в файле уже перекодированный результат), позиция — перемоткой, а не `?t=`; источник берётся
 * из кэша синхронно, если его успели подготовить заранее, иначе — `Promise`.
 */
export function resolveStreamUrl(track: PlayerTrack, startSeconds: number): AudioSource | Promise<AudioSource> {
  const local = offline().playback.resolve(track.id);
  if (local) return local;
  return {
    headers: authHeaders(),
    mode: isTranscoded(track) ? 'transcode' : 'direct',
    url: streamUrl(track.id, startSeconds),
  };
}
