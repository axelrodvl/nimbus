/** Ошибка API: HTTP-статус (0 — сеть), машинный код и сообщение из тела `{ "error": { code, message } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type Result<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

function isErrorBody(value: unknown): value is { error: { code: string; message: string } } {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const e = (value as { error: unknown }).error;
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
}

function toError(res: Result<unknown>): ApiError {
  const { status } = res.response;
  if (isErrorBody(res.error)) return new ApiError(status, res.error.error.code, res.error.error.message);
  return new ApiError(status, 'unknown', res.response.statusText || `HTTP ${status}`);
}

/** Разворачивает ответ openapi-fetch: возвращает `data` или бросает ApiError. */
export function unwrap<T>(res: Result<T>): T {
  if (res.error === undefined && res.data !== undefined) return res.data;
  throw toError(res);
}

/** Для ответов без тела (204): бросает ApiError, если запрос не удался. */
export function unwrapEmpty(res: Result<unknown>): void {
  if (res.response.ok && res.error === undefined) return;
  throw toError(res);
}
