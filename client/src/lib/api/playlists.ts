import { api as defaultClient, type createApiClient } from './client';
import { unwrap, unwrapEmpty } from './errors';

type Client = ReturnType<typeof createApiClient>;

/** Плейлист в клиенте: числовой id или динамическое «Избранное». На сервере id — строка, в синхронизации — число. */
export type PlaylistRef = number | 'favorites';

/** Разбор `:id` из адреса: число или `favorites`; всё остальное — `null` («не найдено»). */
export function parsePlaylistRef(value: string | undefined): PlaylistRef | null {
  if (value === 'favorites') return 'favorites';
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** Созданный на сервере плейлист: числовой id и время (у остальных полей значений нет до первого трека). */
export type CreatedPlaylist = { id: number; name: string; created_at: string };

/** `POST /api/playlists`. */
export async function createPlaylistRequest(name: string, client: Client = defaultClient): Promise<CreatedPlaylist> {
  const dto = unwrap(await client.POST('/api/playlists', { body: { name } }));
  return { created_at: dto.created_at ?? new Date().toISOString(), id: Number(dto.id), name: dto.name };
}

/** `DELETE /api/playlists/{id}`. */
export async function deletePlaylistRequest(id: number, client: Client = defaultClient): Promise<void> {
  unwrapEmpty(await client.DELETE('/api/playlists/{id}', { params: { path: { id: String(id) } } }));
}

/** `POST /api/playlists/{id}/tracks` (повторное добавление сервер принимает без ошибки). */
export async function addPlaylistTrackRequest(
  playlistId: number,
  trackId: number,
  client: Client = defaultClient,
): Promise<void> {
  unwrapEmpty(
    await client.POST('/api/playlists/{id}/tracks', {
      body: { track_id: trackId },
      params: { path: { id: String(playlistId) } },
    }),
  );
}

/** `DELETE /api/playlists/{id}/tracks/{track_id}`. */
export async function removePlaylistTrackRequest(
  playlistId: number,
  trackId: number,
  client: Client = defaultClient,
): Promise<void> {
  unwrapEmpty(
    await client.DELETE('/api/playlists/{id}/tracks/{track_id}', {
      params: { path: { id: String(playlistId), track_id: trackId } },
    }),
  );
}
