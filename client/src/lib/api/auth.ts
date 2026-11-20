import { api as defaultClient, type createApiClient } from './client';
import { unwrap, unwrapEmpty } from './errors';

export type SessionInfo = { auth_required: boolean; authenticated: boolean };

/** Сетевой слой сессии (то, что нужно модулю `lib/auth` от бэкенда). */
export interface AuthApi {
  /** `signal` обрывает запрос (таймаут старта, повторная попытка). */
  session(signal?: AbortSignal): Promise<SessionInfo>;
  login(token: string): Promise<void>;
  logout(): Promise<void>;
}

export function createAuthApi(client: ReturnType<typeof createApiClient> = defaultClient): AuthApi {
  return {
    async login(token) {
      unwrapEmpty(await client.POST('/api/auth/login', { body: { token } }));
    },
    async logout() {
      unwrapEmpty(await client.POST('/api/auth/logout'));
    },
    async session(signal) {
      return unwrap(await client.GET('/api/auth/session', { signal }));
    },
  };
}
