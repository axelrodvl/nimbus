import { describe, expect, it, vi } from 'vitest';
import { errorResponse } from '@/test/factories';
import { createApiClient } from './client';
import { ApiError } from './errors';
import { getArtistImport, removeFromLibraryRequest, retryArtistImport } from './library';

const client = (fetch: typeof globalThis.fetch) => createApiClient({ baseUrl: 'http://x', fetch });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('api/library', () => {
  it('getArtistImport: статус из ответа артиста; нет импорта — null', async () => {
    const status = { attempt: 1, max_attempts: 8, state: 'queued' };
    const fetch = vi.fn(async (_r: RequestInfo | URL) => json({ albums: [], artist: { import: status } }));
    expect(await getArtistImport(5, client(fetch))).toEqual(status);
    expect(new URL((fetch.mock.calls[0]![0] as Request).url).pathname).toBe('/api/artists/5');
    expect(await getArtistImport(5, client(async () => json({ albums: [], artist: {} })))).toBeNull();
  });

  it('getArtistImport: 404 — ApiError', async () => {
    const err = await getArtistImport(5, client(async () => errorResponse(404, 'not_found', 'no'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('retryArtistImport и removeFromLibraryRequest: нужные методы и пути', async () => {
    const fetch = vi.fn(async (_r: RequestInfo | URL) => new Response(null, { status: 204 }));
    await retryArtistImport(3, client(fetch));
    await removeFromLibraryRequest('album', 8, client(fetch));
    const calls = fetch.mock.calls.map(([r]) => `${(r as Request).method} ${new URL((r as Request).url).pathname}`);
    expect(calls).toEqual(['POST /api/artists/3/import', 'DELETE /api/library/album/8']);
  });

  it('removeFromLibraryRequest: 500 — ApiError', async () => {
    await expect(
      removeFromLibraryRequest('artist', 1, client(async () => errorResponse(500, 'internal', 'boom'))),
    ).rejects.toMatchObject({ code: 'internal', status: 500 });
  });
});
