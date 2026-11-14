import { describe, expect, it, vi } from 'vitest';
import { errorResponse } from '@/test/factories';
import { createApiClient } from './client';
import { postPlayed } from './tracks';

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
