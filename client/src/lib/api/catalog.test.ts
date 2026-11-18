import { describe, expect, it, vi } from 'vitest';
import { fetchCatalogAlbum, fetchCatalogArtist } from './catalog';
import { createApiClient } from './client';
import { ApiError } from './errors';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

describe('каталог MusicBrainz', () => {
  it('артист и альбом — GET по mbid, ответ как есть', async () => {
    const fetch = vi.fn(async (req: RequestInfo | URL) => json({ url: new URL((req as Request).url).pathname }));
    const client = createApiClient({ baseUrl: 'http://x', fetch });
    await expect(fetchCatalogArtist('m-1', undefined, client)).resolves.toEqual({ url: '/api/catalog/artists/m-1' });
    await expect(fetchCatalogAlbum('m-2', undefined, client)).resolves.toEqual({ url: '/api/catalog/albums/m-2' });
  });

  it('404 — ApiError с кодом сервера', async () => {
    const fetch = vi.fn(async () => json({ error: { code: 'mb_not_found', message: 'nope' } }, 404));
    const client = createApiClient({ baseUrl: 'http://x', fetch });
    const err = await fetchCatalogAlbum('m', undefined, client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'mb_not_found', status: 404 });
  });
});
