import { api as defaultClient, type createApiClient, type Schemas } from './client';
import { unwrap } from './errors';

/** `POST /api/tracks/{id}/played`: засчитать прослушивание. Возвращает новый счётчик. */
export async function postPlayed(
  trackId: number,
  client: ReturnType<typeof createApiClient> = defaultClient,
): Promise<number> {
  const res = unwrap(await client.POST('/api/tracks/{id}/played', { params: { path: { id: trackId } } }));
  return res.play_count;
}

/** `POST /api/tracks/{id}/prefetch`: сервер заранее качает начало трека (ошибки вызывающему не важны). */
export async function prefetchTrack(
  trackId: number,
  client: ReturnType<typeof createApiClient> = defaultClient,
): Promise<void> {
  unwrap(await client.POST('/api/tracks/{id}/prefetch', { params: { path: { id: trackId } } }));
}

export type AudioInfoDto = Schemas['AudioInfo'];

/** `GET /api/tracks/{id}/audio-info`: параметры исходного аудио (кодек, разрядность, частота). */
export async function getAudioInfo(
  trackId: number,
  signal?: AbortSignal,
  client: ReturnType<typeof createApiClient> = defaultClient,
): Promise<AudioInfoDto> {
  return unwrap(await client.GET('/api/tracks/{id}/audio-info', { params: { path: { id: trackId } }, signal }));
}

/** `GET /api/tracks/{id}`: трек напрямую (для сторожа ожидания, когда синхронизация молчит). */
export async function getTrack(
  trackId: number,
  client: ReturnType<typeof createApiClient> = defaultClient,
): Promise<Schemas['TrackDto']> {
  return unwrap(await client.GET('/api/tracks/{id}', { params: { path: { id: trackId } } }));
}
