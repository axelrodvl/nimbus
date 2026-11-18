import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorResponse } from '@/test/factories';
import { createApiClient, onUnauthorized } from './client';
import { ApiError, unwrap, unwrapEmpty } from './errors';

afterEach(() => onUnauthorized(null));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

describe('разбор ошибок', () => {
  it('тело ошибки бэкенда превращается в ApiError с кодом и сообщением', async () => {
    const fetch = vi.fn(async () => errorResponse(404, 'not_found', 'No such artist'));
    const api = createApiClient({ baseUrl: 'http://x', fetch });
    const err = await api
      .GET('/api/health')
      .then(unwrap)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'not_found', message: 'No such artist', status: 404 });
  });

  it('ошибка без тела — код unknown и statusText', () => {
    const response = new Response('boom', { status: 502, statusText: 'Bad Gateway' });
    expect(() => unwrap({ error: 'boom', response })).toThrow(
      expect.objectContaining({ code: 'unknown', status: 502 }),
    );
    const bare = new Response(null, { status: 500 });
    expect(() => unwrap({ error: undefined, response: bare })).toThrow(/HTTP 500/);
  });

  it('unwrapEmpty пропускает 2xx и бросает на ошибке', () => {
    expect(() => unwrapEmpty({ response: new Response(null, { status: 204 }) })).not.toThrow();
    const response = new Response(null, { status: 409 });
    expect(() => unwrapEmpty({ error: { error: { code: 'conflict', message: 'dup' } }, response })).toThrow(
      expect.objectContaining({ code: 'conflict', status: 409 }),
    );
  });
});

describe('клиент', () => {
  it('успешный ответ возвращает данные', async () => {
    const fetch = vi.fn(async () => json({ db: true, status: 'ok', version: '1' }));
    const api = createApiClient({ baseUrl: 'http://x', fetch });
    const data = unwrap(await api.GET('/api/health'));
    expect(data).toMatchObject({ status: 'ok' });
  });

  it('401 вызывает onUnauthorized', async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    const fetch = vi.fn(async () => errorResponse(401, 'unauthorized', 'no'));
    const api = createApiClient({ baseUrl: 'http://x', fetch });
    await api.GET('/api/health');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('401 без обработчика не падает', async () => {
    const fetch = vi.fn(async () => errorResponse(401, 'unauthorized', 'no'));
    const api = createApiClient({ baseUrl: 'http://x', fetch });
    await expect(api.GET('/api/health')).resolves.toBeDefined();
  });

  it('сетевой сбой — ApiError с code = network', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const api = createApiClient({ baseUrl: 'http://x', fetch });
    await expect(api.GET('/api/health')).rejects.toMatchObject({ code: 'network', name: 'ApiError', status: 0 });
  });

  it('не-Error в сбое тоже даёт network', async () => {
    const fetch = vi.fn(async () => {
      throw 'offline';
    });
    const api = createApiClient({ baseUrl: 'http://x', fetch });
    await expect(api.GET('/api/health')).rejects.toMatchObject({ code: 'network', message: 'Network error' });
  });

  it('запросы идут с cookie (credentials: include)', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => json({ db: true, status: 'ok', version: '1' }));
    const api = createApiClient({ baseUrl: 'http://x', fetch });
    await api.GET('/api/health');
    expect((fetch.mock.calls[0]?.[0] as Request).credentials).toBe('include');
  });
});

describe('ApiError.field из тела ошибки', () => {
  it('поле валидации попадает в ApiError; нестроковое игнорируется', async () => {
    const make = (field: unknown) =>
      createApiClient({
        baseUrl: 'http://x',
        fetch: async () =>
          new Response(JSON.stringify({ error: { code: 'invalid_settings', field, message: 'bad' } }), {
            headers: { 'content-type': 'application/json' },
            status: 400,
          }),
      });
    await expect(make('musicbrainz.burst').GET('/api/settings').then(unwrap)).rejects.toMatchObject({
      code: 'invalid_settings',
      field: 'musicbrainz.burst',
    });
    await expect(make(5).GET('/api/settings').then(unwrap)).rejects.toMatchObject({ field: undefined });
  });
});
