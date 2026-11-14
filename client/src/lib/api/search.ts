import { api as defaultClient, type createApiClient, type Schemas } from './client';
import { unwrap } from './errors';

type Client = ReturnType<typeof createApiClient>;

import type { SearchResponse } from './search-types';

export type { SearchResponse };

export type AddInput =
  { type: 'artist' | 'album'; mbid: string } | { type: 'track'; mbid: string; albumMbid?: string | null };
export type AddResult = Schemas['AddToLibraryResponse'];

/** `GET /api/search`: поиск в MusicBrainz. `signal` отменяет устаревший запрос. */
export async function searchRemote(
  q: string,
  signal?: AbortSignal,
  client: Client = defaultClient,
): Promise<SearchResponse> {
  return unwrap(await client.GET('/api/search', { params: { query: { q } }, signal }));
}

/** `POST /api/library`: добавить артиста, альбом (release group) или трек (recording) в библиотеку. */
export async function addToLibraryRequest(input: AddInput, client: Client = defaultClient): Promise<AddResult> {
  const body =
    input.type === 'track'
      ? { album_mbid: input.albumMbid ?? null, mbid: input.mbid, type: input.type }
      : { mbid: input.mbid, type: input.type };
  return unwrap(await client.POST('/api/library', { body }));
}
