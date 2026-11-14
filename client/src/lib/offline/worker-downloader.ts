import type { DownloadMessage, Downloader, DownloadStart, WorkerRequest } from './types';

/** Часть `Worker`, которая нужна модулю (в тестах — фейк). */
export type WorkerLike = {
  postMessage(message: WorkerRequest): void;
  onmessage: ((e: { data: DownloadMessage }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
};

/**
 * `Downloader` для PWA: обёртка над воркером скачивания; воркер создаётся при первой загрузке.
 * Не фоновый (`background = false`): вкладку может выгрузить браузер, докачка — забота менеджера.
 */
export function createWorkerDownloader(create: () => WorkerLike): Downloader {
  const handlers = new Set<(m: DownloadMessage) => void>();
  const active = new Set<string>();
  /** Ожидающие подтверждения отмены: трекId → резолверы. */
  const releasing = new Map<string, (() => void)[]>();
  let worker: WorkerLike | null = null;

  const release = (trackId: string) => {
    for (const resolve of releasing.get(trackId) ?? []) resolve();
    releasing.delete(trackId);
  };

  const emit = (m: DownloadMessage) => {
    if (m.type === 'aborted') {
      // Подтверждение отмены нужно только `abort()`; менеджеру оно не передаётся.
      release(m.trackId);
      return;
    }
    if (m.type !== 'progress') active.delete(m.trackId);
    for (const h of [...handlers]) h(m);
  };

  function ensure(): WorkerLike {
    if (worker) return worker;
    const w = create();
    w.onmessage = e => emit(e.data);
    w.onerror = () => {
      // Воркер упал: все его загрузки — повторяемая ошибка; следующий `start` создаст воркер заново.
      w.terminate();
      if (worker === w) worker = null;
      for (const trackId of [...active]) emit({ bytesDone: 0, code: 'storage', retryable: true, trackId, type: 'error' });
      // Воркера нет — файлы свободны.
      for (const trackId of [...releasing.keys()]) release(trackId);
    };
    worker = w;
    return w;
  }

  return {
    abort(trackId) {
      if (!active.delete(trackId) || !worker) return Promise.resolve();
      const confirmed = new Promise<void>(resolve => releasing.set(trackId, [...(releasing.get(trackId) ?? []), resolve]));
      worker.postMessage({ trackId, type: 'abort' });
      return confirmed;
    },
    background: false,
    on(handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    start(p: DownloadStart) {
      active.add(p.trackId);
      ensure().postMessage({ ...p, type: 'start' });
    },
  };
}
