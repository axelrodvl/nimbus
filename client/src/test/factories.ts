import { ApiError } from '@/lib/api/errors';

/** Ответ бэкенда с телом ошибки `{ error: { code, message } }`. */
export function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

export const apiError = (status = 500, code = 'internal', message = 'boom') => new ApiError(status, code, message);
