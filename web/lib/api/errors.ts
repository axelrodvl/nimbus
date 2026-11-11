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

// Разворачивает ответ openapi-fetch: возвращает `data` или бросает ApiError
// с кодом и сообщением из `{ "error": { "code", "message" } }`.
export function unwrap<T>(res: Result<T>): T {
  if (res.error === undefined && res.data !== undefined) return res.data;
  const { status } = res.response;
  if (isErrorBody(res.error)) throw new ApiError(status, res.error.error.code, res.error.error.message);
  throw new ApiError(status, 'unknown', res.response.statusText || `HTTP ${status}`);
}
