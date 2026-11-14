import { describe, expect, it, vi } from 'vitest';
import { errorResponse } from '@/test/factories';
import { createAuthApi } from './auth';
import { createApiClient } from './client';

const make = (fetch: typeof globalThis.fetch) => createAuthApi(createApiClient({ baseUrl: 'http://x', fetch }));

describe('API сессии', () => {
  it('session возвращает ответ бэкенда', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return Response.json({ auth_required: true, authenticated: false });
    });
    expect(await make(fetch).session()).toEqual({ auth_required: true, authenticated: false });
    expect(new URL((fetch.mock.calls[0]?.[0] as Request).url).pathname).toBe('/api/auth/session');
  });

  it('login отправляет токен; 401 → ApiError', async () => {
    const fetch = vi.fn(async (req: Request) =>
      (await req.clone().json()).token === 'ok'
        ? new Response(null, { status: 204 })
        : errorResponse(401, 'unauthorized', 'no'),
    );
    const api = make(fetch as unknown as typeof globalThis.fetch);
    await expect(api.login('ok')).resolves.toBeUndefined();
    await expect(api.login('bad')).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('logout: 204 — успех, ошибка сети — ApiError(0)', async () => {
    await expect(make(async () => new Response(null, { status: 204 })).logout()).resolves.toBeUndefined();
    await expect(
      make(async () => {
        throw new TypeError('down');
      }).logout(),
    ).rejects.toMatchObject({ status: 0 });
  });
});
