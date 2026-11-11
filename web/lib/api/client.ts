import createClient from 'openapi-fetch';
import { publicBackendUrl, serverBackendUrl } from '@/lib/env';
import type { components, paths } from './schema';

// На сервере — BACKEND_URL, в браузере — NEXT_PUBLIC_BACKEND_URL.
export const api = createClient<paths>({
  baseUrl: typeof window === 'undefined' ? serverBackendUrl : publicBackendUrl,
});

export type Schemas = components['schemas'];
