import { describe, expect, it } from 'vitest';
import { errorResponse } from '@/test/factories';
import { createApiClient } from './client';
import {
  fetchServerVersion,
  fetchSettings,
  fetchStorage,
  loadPrefetchEnabled,
  putSettings,
  reimportArtists,
  retryMissing,
  testProvider,
} from './settings';

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

describe('запросы настроек', () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const recording = (body: unknown, status = 200) =>
    createApiClient({
      baseUrl: 'http://x',
      fetch: async (input, init) => {
        const req = new Request(input, init);
        calls.push({
          body: req.method === 'GET' ? null : await req.json().catch(() => null),
          method: req.method,
          url: new URL(req.url).pathname,
        });
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });
      },
    });

  it('fetchSettings / putSettings: GET и PUT с патчем', async () => {
    calls.length = 0;
    expect(await fetchSettings(undefined, recording({ search: { max_candidates: 3 } }))).toEqual({
      search: { max_candidates: 3 },
    });
    await putSettings({ search: { max_candidates: 5 } }, recording({}));
    expect(calls).toEqual([
      { body: null, method: 'GET', url: '/api/settings' },
      { body: { search: { max_candidates: 5 } }, method: 'PUT', url: '/api/settings' },
    ]);
  });

  it('хранилище, проверка провайдера, переимпорт, повтор поиска, версия сервера', async () => {
    calls.length = 0;
    expect((await fetchStorage(undefined, recording({ files: 1, limit_bytes: 2 }))).files).toBe(1);
    expect((await testProvider('tpb', recording({ message: 'ok', ok: true, sample_count: 3 }))).ok).toBe(true);
    expect(await reimportArtists(recording({ queued: 4 }))).toBe(4);
    expect(await retryMissing(recording({ queued: 2 }, 202))).toBe(2);
    expect(await fetchServerVersion(undefined, recording({ version: '1.2.3' }))).toBe('1.2.3');
    expect(await fetchServerVersion(undefined, recording({}))).toBe('');
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'GET /api/storage',
      'POST /api/settings/providers/test',
      'POST /api/settings/reimport-artists',
      'POST /api/acquisition/retry',
      'GET /api/health',
      'GET /api/health',
    ]);
    expect(calls[1]?.body).toEqual({ provider: 'tpb' });
    expect(calls[3]?.body).toEqual({ scope: 'missing' });
  });
});
