import { describe, expect, it, vi } from 'vitest';
import { errorResponse } from '@/test/factories';
import { createApiClient } from './client';
import { getAudioInfo, getTrack, postPlayed, prefetchTrack } from './tracks';

describe('postPlayed', () => {
  it('POST /api/tracks/{id}/played → новый счётчик', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ play_count: 4 }), { headers: { 'content-type': 'application/json' } }),
    );
    const client = createApiClient({ baseUrl: 'http://x', fetch });
    expect(await postPlayed(7, client)).toBe(4);
    const req = fetch.mock.calls[0]?.[0] as Request;
    expect(req.method).toBe('POST');
    expect(new URL(req.url).pathname).toBe('/api/tracks/7/played');
  });

  it('404 → ApiError', async () => {
    const client = createApiClient({ baseUrl: 'http://x', fetch: async () => errorResponse(404, 'not_found', 'no') });
    await expect(postPlayed(1, client)).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('prefetchTrack / getAudioInfo', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

  it('POST /api/tracks/{id}/prefetch', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => json({ state: 'started' }, 202));
    await prefetchTrack(9, createApiClient({ baseUrl: 'http://x', fetch }));
    const req = fetch.mock.calls[0]?.[0] as Request;
    expect(req.method).toBe('POST');
    expect(new URL(req.url).pathname).toBe('/api/tracks/9/prefetch');
  });

  it('prefetch: ошибка сервера → ApiError', async () => {
    const client = createApiClient({ baseUrl: 'http://x', fetch: async () => errorResponse(404, 'not_found', 'no') });
    await expect(prefetchTrack(1, client)).rejects.toMatchObject({ status: 404 });
  });

  it('GET /api/tracks/{id}/audio-info', async () => {
    const info = {
      bit_depth: 16,
      bitrate_kbps: null,
      channels: 'stereo',
      codec: 'flac',
      ext: 'flac',
      sample_rate: 44100,
      transcoded: false,
    };
    const fetch = vi.fn(async (_input: RequestInfo | URL) => json(info));
    const client = createApiClient({ baseUrl: 'http://x', fetch });
    expect(await getAudioInfo(4, undefined, client)).toEqual(info);
    expect(new URL((fetch.mock.calls[0]?.[0] as Request).url).pathname).toBe('/api/tracks/4/audio-info');
  });
});

describe('getTrack', () => {
  it('GET /api/tracks/{id}', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ id: 9, status: 'found' }), { headers: { 'content-type': 'application/json' } }),
    );
    const client = createApiClient({ baseUrl: 'http://x', fetch });
    expect(await getTrack(9, client)).toMatchObject({ id: 9, status: 'found' });
    expect(new URL((fetch.mock.calls[0]?.[0] as Request).url).pathname).toBe('/api/tracks/9');
  });
});
