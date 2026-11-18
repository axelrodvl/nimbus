import { api as defaultClient, type createApiClient, type Schemas } from './client';
import { unwrap } from './errors';

type Client = ReturnType<typeof createApiClient>;

export type CatalogArtistResponse = Schemas['CatalogArtistResponse'];
export type CatalogAlbumResponse = Schemas['CatalogAlbumResponse'];
export type CatalogTrack = Schemas['CatalogTrack'];

/** `GET /api/catalog/artists/{mbid}`: артист и его альбомы из MusicBrainz (может не быть в библиотеке). */
export async function fetchCatalogArtist(
  mbid: string,
  signal?: AbortSignal,
  client: Client = defaultClient,
): Promise<CatalogArtistResponse> {
  return unwrap(await client.GET('/api/catalog/artists/{mbid}', { params: { path: { mbid } }, signal }));
}

/** `GET /api/catalog/albums/{mbid}`: альбом (release group) и его треклист из MusicBrainz. */
export async function fetchCatalogAlbum(
  mbid: string,
  signal?: AbortSignal,
  client: Client = defaultClient,
): Promise<CatalogAlbumResponse> {
  return unwrap(await client.GET('/api/catalog/albums/{mbid}', { params: { path: { mbid } }, signal }));
}

export type PlayInput = { type: 'track' | 'album'; mbid: string; albumMbid?: string | null };
export type PlayResponse = Schemas['PlayResponse'];

/**
 * `POST /api/play`: сыграть трек или альбом, не добавляя в библиотеку. Сервер сохраняет метаданные и ищет источник;
 * ответ — id треков в порядке треклиста, статусы приходят синхронизацией.
 */
export async function requestPlay(
  input: PlayInput,
  signal?: AbortSignal,
  client: Client = defaultClient,
): Promise<PlayResponse> {
  const body =
    input.type === 'track'
      ? { album_mbid: input.albumMbid ?? null, mbid: input.mbid, type: input.type }
      : { mbid: input.mbid, type: input.type };
  return unwrap(await client.POST('/api/play', { body, signal }));
}
