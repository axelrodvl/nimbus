import { describe, expect, it } from 'vitest';
import { errorResponse } from '@/test/factories';
import { createApiClient } from './client';
import { loadPrefetchEnabled } from './settings';

const settings = (body: unknown) =>
  createApiClient({
    baseUrl: 'http://x',
    fetch: async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
  });

describe('loadPrefetchEnabled', () => {
  it('читает playback.prefetch_next', async () => {
    expect(await loadPrefetchEnabled(settings({ playback: { prefetch_next: false } }))).toBe(false);
    expect(await loadPrefetchEnabled(settings({ playback: { prefetch_next: true } }))).toBe(true);
  });

  it('нет поля или ошибка запроса — включено (значение по умолчанию)', async () => {
    expect(await loadPrefetchEnabled(settings({}))).toBe(true);
    expect(
      await loadPrefetchEnabled(
        createApiClient({ baseUrl: 'http://x', fetch: async () => errorResponse(500, 'internal', 'x') }),
      ),
    ).toBe(true);
  });
});
