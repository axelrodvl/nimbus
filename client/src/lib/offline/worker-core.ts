import { downloadTo, IDLE_TIMEOUT_MS, type Sink } from './download';
import type { DownloadMessage, WorkerRequest } from './types';

export type OpenedSink = { sink: Sink; close(): void };

export type WorkerCoreDeps = {
  /** Открывает файл трека на запись (в воркере — `createSyncAccessHandle`; эксклюзивно до `close`). */
  openSink(trackId: string): Promise<OpenedSink>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  post(message: DownloadMessage): void;
  idleTimeoutMs?: number;
  now?: () => number;
};

/**
 * Логика воркера скачивания без привязки к `self`: `start` качает файл (повторный `start` того же трека сначала
 * отменяет прежний и ждёт освобождения файла), `abort` прерывает. Отмена ничего не сообщает — о ней знает тот, кто её вызвал.
 */
export function createWorkerCore(deps: WorkerCoreDeps) {
  const running = new Map<string, { ctl: AbortController; done: Promise<void> }>();

  async function run(req: Extract<WorkerRequest, { type: 'start' }>, ctl: AbortController, previous?: Promise<void>) {
    await previous;
    const { trackId } = req;
    let opened: OpenedSink | null = null;
    try {
      if (ctl.signal.aborted) return;
      opened = await deps.openSink(trackId);
      const result = await downloadTo(opened.sink, deps.fetch, {
        etag: req.etag,
        headers: req.headers,
        idleTimeoutMs: deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
        now: deps.now,
        offset: req.offset,
        onProgress: info => deps.post({ type: 'progress', trackId, ...info }),
        signal: ctl.signal,
        url: req.url,
      });
      if (result.ok) {
        deps.post({ bytes: result.bytes, etag: result.etag, mime: result.mime, resumable: result.resumable, trackId, type: 'done' });
      } else if (result.code !== 'aborted') {
        deps.post({ bytesDone: result.bytesDone, code: result.code, info: result.info, retryable: result.retryable, trackId, type: 'error' });
      }
    } catch (e) {
      const quota = (e as { name?: string } | null)?.name === 'QuotaExceededError';
      deps.post({ bytesDone: 0, code: quota ? 'quota' : 'storage', retryable: !quota, trackId, type: 'error' });
    } finally {
      opened?.close();
    }
  }

  return {
    handle(req: WorkerRequest): void {
      if (req.type === 'abort') {
        running.get(req.trackId)?.ctl.abort();
        return;
      }
      const previous = running.get(req.trackId);
      previous?.ctl.abort();
      const ctl = new AbortController();
      const done = run(req, ctl, previous?.done).finally(() => {
        if (running.get(req.trackId)?.ctl === ctl) running.delete(req.trackId);
        // Файл закрыт (`run` завершился): тот, кто отменял загрузку, может его удалять.
        if (ctl.signal.aborted) deps.post({ trackId: req.trackId, type: 'aborted' });
      });
      running.set(req.trackId, { ctl, done });
    },
    /** Для тестов: все текущие загрузки завершены. */
    idle: () => Promise.all([...running.values()].map(r => r.done)).then(() => undefined),
  };
}
