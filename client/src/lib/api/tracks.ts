import { api as defaultClient, type createApiClient } from './client';
import { unwrap } from './errors';

/** `POST /api/tracks/{id}/played`: засчитать прослушивание. Возвращает новый счётчик. */
export async function postPlayed(
  trackId: number,
  client: ReturnType<typeof createApiClient> = defaultClient,
): Promise<number> {
  const res = unwrap(await client.POST('/api/tracks/{id}/played', { params: { path: { id: trackId } } }));
  return res.play_count;
}
