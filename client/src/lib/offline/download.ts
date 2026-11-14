import type { DownloadErrorCode, DownloadInfo } from './types';

/** Запись в файл: в воркере — `FileSystemSyncAccessHandle`, в тестах — память. */
export interface Sink {
  size(): number;
  write(chunk: Uint8Array, at: number): void;
  truncate(size: number): void;
  flush(): void;
}

export type DownloadParams = {
  url: string;
  headers: Record<string, string>;
  offset: number;
  etag: string | null;
  signal?: AbortSignal;
  /** Не чаще раза в `PROGRESS_INTERVAL_MS`. */
  onProgress?: (info: DownloadInfo) => void;
  /** Нет данных дольше этого срока — обрыв с повтором (`found`-треки сервер сначала качает из торрента). */
  idleTimeoutMs?: number;
  now?: () => number;
};

export type DownloadResult =
  | ({ ok: true; bytes: number } & DownloadInfo)
  /** `info` — что известно о файле к моменту ошибки (заголовки уже получены): по нему менеджер докачивает. */
  | { ok: false; code: DownloadErrorCode; retryable: boolean; bytesDone: number; info?: DownloadInfo };

export const FLUSH_EVERY_BYTES = 4 * 2 ** 20;
export const PROGRESS_INTERVAL_MS = 250;
export const IDLE_TIMEOUT_MS = 180_000;
const DEFAULT_MIME = 'application/octet-stream';

/** Сброс на диск при обрыве не должен подменять первопричину ошибкой записи. */
function flushQuietly(sink: Sink) {
  try {
    sink.flush();
  } catch {
    // Данные до последнего успешного flush всё равно на диске.
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const fail = (code: DownloadErrorCode, retryable: boolean, bytesDone: number, info?: DownloadInfo): DownloadResult => ({
  bytesDone,
  code,
  ...(info ? { info: { ...info, bytesDone } } : {}),
  ok: false,
  retryable,
});

const isQuota = (e: unknown) => (e as { name?: string } | null)?.name === 'QuotaExceededError';

/** `bytes a-b/total` → `[a, total|null]`. */
function parseContentRange(value: string | null): { start: number; total: number | null } | null {
  const m = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(value ?? '');
  return m ? { start: Number(m[1]), total: m[2] === '*' ? null : Number(m[2]) } : null;
}

/**
 * Скачивает один файл в `sink` (чистая функция: воркер лишь подставляет `SyncAccessHandle`).
 * `206` дописывает с `offset`, `200` пишет с нуля, `416` — файл уже полный (проверка размера).
 */
export async function downloadTo(sink: Sink, fetchFn: FetchLike, p: DownloadParams): Promise<DownloadResult> {
  const now = p.now ?? Date.now;
  const headers = { ...p.headers };
  if (p.offset > 0) {
    headers.Range = `bytes=${p.offset}-`;
    if (p.etag) headers['If-Range'] = p.etag;
  }
  // Один контроллер: внешняя отмена и таймаут простоя.
  const ctl = new AbortController();
  let timedOut = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(idle);
    if (p.idleTimeoutMs === undefined) return;
    idle = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, p.idleTimeoutMs);
  };
  const onAbort = () => ctl.abort();
  if (p.signal?.aborted) return fail('aborted', false, p.offset);
  p.signal?.addEventListener('abort', onAbort);
  /** Заголовки получены: с этого момента известно, докачиваем ли файл. */
  let known: DownloadInfo | undefined;
  const interrupted = (done: number, e: unknown): DownloadResult => {
    if (isQuota(e)) return fail('quota', false, done, known);
    if (timedOut) return fail('timeout', true, done, known);
    if (ctl.signal.aborted) return fail('aborted', false, done, known);
    return fail('network', true, done, known);
  };

  let pos = p.offset;
  try {
    arm();
    let res: Response;
    try {
      res = await fetchFn(p.url, { credentials: 'include', headers, signal: ctl.signal });
    } catch (e) {
      return interrupted(p.offset, e);
    }
    if (res.status === 416) {
      const m = /^bytes \*\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
      const size = sink.size();
      if (m && size > 0 && size === Number(m[1])) {
        // Файл уже полный; `mime` пуст — менеджер оставляет прежний из записи.
        return { bytes: size, bytesDone: size, bytesTotal: size, etag: p.etag, mime: '', ok: true, resumable: true };
      }
      // Сервер считает смещение недопустимым, а файл не совпадает: начнём заново.
      sink.truncate(0);
      return fail('incomplete', true, 0);
    }
    if (res.status === 401) return fail('unauthorized', false, p.offset);
    if (res.status === 404 || res.status === 410) return fail('not_found', false, p.offset);
    // 409 — трек ещё не готов к выдаче, 408/429/5xx — временные отказы.
    if (res.status === 409 || res.status === 408 || res.status === 429 || res.status >= 500) {
      return fail('http_status', true, p.offset);
    }
    if (!res.ok) return fail('http_status', false, p.offset);

    const range = res.status === 206 ? parseContentRange(res.headers.get('content-range')) : null;
    const length = Number(res.headers.get('content-length'));
    const hasLength = res.headers.has('content-length') && Number.isFinite(length);
    let total: number | null;
    if (res.status === 206) {
      pos = range?.start ?? p.offset;
      total = range?.total ?? (hasLength ? pos + length : null);
      const responseEtag = res.headers.get('etag');
      if (pos !== p.offset || (p.etag && responseEtag && responseEtag !== p.etag)) {
        // Сервер ответил другим диапазоном или другой версией файла: склеивать нельзя, следующая попытка — с нуля.
        sink.truncate(0);
        return fail('incomplete', true, 0);
      }
      if (sink.size() < pos) {
        // Начало файла потеряно (очистка хранилища): докачивать не к чему, следующая попытка — с нуля.
        sink.truncate(0);
        return fail('incomplete', true, 0);
      }
      sink.truncate(pos);
    } else {
      pos = 0;
      total = hasLength ? length : null;
      sink.truncate(0);
    }
    const etag = res.headers.get('etag');
    const resumable = (res.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes') && etag !== null;
    const mime = res.headers.get('content-type') || DEFAULT_MIME;
    const info = (): DownloadInfo => ({ bytesDone: pos, bytesTotal: total, etag, mime, resumable });
    known = info();

    if (!res.body) return fail('network', true, pos);
    const reader = res.body.getReader();
    // Отмена и таймаут закрывают поток, даже если fetch не связал его с сигналом.
    const cancelReader = () => void reader.cancel().catch(() => undefined);
    ctl.signal.addEventListener('abort', cancelReader);
    let sinceFlush = 0;
    let lastProgress = now();
    for (;;) {
      arm();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        flushQuietly(sink);
        return interrupted(pos, e);
      }
      if (chunk.done) break;
      sink.write(chunk.value, pos);
      pos += chunk.value.byteLength;
      sinceFlush += chunk.value.byteLength;
      if (sinceFlush >= FLUSH_EVERY_BYTES) {
        sink.flush();
        sinceFlush = 0;
      }
      const t = now();
      if (p.onProgress && t - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = t;
        p.onProgress(info());
      }
    }
    if (ctl.signal.aborted) {
      flushQuietly(sink);
      return interrupted(pos, null);
    }
    sink.flush();
    if (total !== null && pos !== total) return fail('incomplete', true, pos, info());
    return { ...info(), bytes: pos, bytesTotal: total ?? pos, ok: true };
  } catch (e) {
    // Запись в файл (квота диска) или иная ошибка хранилища.
    return isQuota(e) ? fail('quota', false, pos, known) : fail('storage', true, pos, known);
  } finally {
    clearTimeout(idle);
    p.signal?.removeEventListener('abort', onAbort);
  }
}
