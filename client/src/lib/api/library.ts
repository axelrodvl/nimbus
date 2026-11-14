import { api as defaultClient, type createApiClient, type Schemas } from './client';
import { unwrap, unwrapEmpty } from './errors';

type Client = ReturnType<typeof createApiClient>;

export type ArtistImport = NonNullable<Schemas['ArtistDto']['import']>;

/** `GET /api/artists/{id}`: статус импорта дискографии (единственные данные экрана артиста не из store). */
export async function getArtistImport(id: number, client: Client = defaultClient): Promise<ArtistImport | null> {
  const res = unwrap(await client.GET('/api/artists/{id}', { params: { path: { id } } }));
  return res.artist.import ?? null;
}

/** `POST /api/artists/{id}/import`: повторить импорт дискографии. */
export async function retryArtistImport(id: number, client: Client = defaultClient): Promise<void> {
  unwrapEmpty(await client.POST('/api/artists/{id}/import', { params: { path: { id } } }));
}

/** `DELETE /api/library/{type}/{id}`: убрать артиста или альбом из библиотеки. */
export async function removeFromLibraryRequest(
  type: 'artist' | 'album',
  id: number,
  client: Client = defaultClient,
): Promise<void> {
  unwrapEmpty(await client.DELETE('/api/library/{type}/{id}', { params: { path: { id, type } } }));
}
