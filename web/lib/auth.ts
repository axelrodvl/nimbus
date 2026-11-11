// Общие правила cookie авторизации (значение — hex от токена, как на бэкенде).
export const AUTH_COOKIE = 'nimbus_token';
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function encodeToken(token: string): string {
  return Array.from(new TextEncoder().encode(token), b => b.toString(16).padStart(2, '0')).join('');
}
