import createClient, { type Middleware } from 'openapi-fetch';
import { authHeaders } from '@/lib/platform/auth-transport';
import { apiBase } from '@/lib/platform/urls';
import { ApiError } from './errors';
import type { components, paths } from './schema';

export type Schemas = components['schemas'];

let unauthorizedHandler: (() => void) | null = null;

/** Общий обработчик 401 (экран входа подключает шаг 38). `null` снимает обработчик. */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

const middleware: Middleware = {
  onError({ error }) {
    // Сеть недоступна / запрос оборван: единый тип ошибки для UI.
    if (error instanceof ApiError) return error;
    return new ApiError(0, 'network', error instanceof Error ? error.message : 'Network error');
  },
  onRequest({ request }) {
    for (const [name, value] of Object.entries(authHeaders())) request.headers.set(name, value);
    return request;
  },
  onResponse({ response }) {
    if (response.status === 401) unauthorizedHandler?.();
  },
};

export function createApiClient(options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {}) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? apiBase(),
    credentials: 'include',
    fetch: options.fetch,
  });
  client.use(middleware);
  return client;
}

export const api = createApiClient();
