/**
 * Заголовки авторизации для запросов к бэкенду. В PWA пусто: авторизует cookie.
 * Все запросы (API-клиент, скачивание, WebSocket) получают заголовки отсюда — нативные оболочки подставят токен.
 */
export function authHeaders(): Record<string, string> {
  return {};
}
