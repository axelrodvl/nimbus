import createClient from 'openapi-fetch';
import { publicBackendUrl, serverBackendUrl } from '@/lib/env';
import type { components, paths } from './schema';

const isServer = typeof window === 'undefined';

// На сервере — BACKEND_URL, в браузере — NEXT_PUBLIC_BACKEND_URL (пусто — тот же origin).
// Серверные запросы идут с токеном из окружения веб-сервера (NIMBUS_API_TOKEN): они выполняются
// в том числе внутри `'use cache'`, где cookie запроса недоступны. Доступ пользователя к самому
// вебу проверяет `proxy.ts`; браузерные запросы (stream, ws) авторизуются cookie `nimbus_token`.
const serverToken = isServer ? process.env.NIMBUS_API_TOKEN?.trim() : undefined;

export const api = createClient<paths>({
  baseUrl: isServer ? serverBackendUrl : publicBackendUrl,
  headers: serverToken ? { Authorization: `Bearer ${serverToken}` } : undefined,
});

export type Schemas = components['schemas'];
