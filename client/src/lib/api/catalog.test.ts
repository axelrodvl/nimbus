import { describe, expect, it, vi } from 'vitest';
import { fetchCatalogAlbum, fetchCatalogArtist, requestPlay } from './catalog';
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

  it('«сыграть»: POST /api/play с типом; у трека — альбом, у альбома — только mbid', async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (req: RequestInfo | URL) => {
      const r = req as Request;
      bodies.push([new URL(r.url).pathname, r.method, await r.json()]);
      return json({ album_id: 1, track_ids: [5], tracks: [{ id: 5, status: 'adding' }] });
    });
    const client = createApiClient({ baseUrl: 'http://x', fetch });
    await expect(requestPlay({ albumMbid: 'rg', mbid: 'rec', type: 'track' }, undefined, client)).resolves.toEqual({
      album_id: 1,
      track_ids: [5],
      tracks: [{ id: 5, status: 'adding' }],
    });
    await requestPlay({ mbid: 'rg', type: 'album' }, undefined, client);
    await requestPlay({ mbid: 'rec', type: 'track' }, undefined, client);
    expect(bodies).toEqual([
      ['/api/play', 'POST', { album_mbid: 'rg', mbid: 'rec', type: 'track' }],
      ['/api/play', 'POST', { mbid: 'rg', type: 'album' }],
      ['/api/play', 'POST', { album_mbid: null, mbid: 'rec', type: 'track' }],
    ]);
  });
});
