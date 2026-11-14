import { describe, expect, it, vi } from 'vitest';
import type { Sink } from './download';
import type { DownloadMessage, WorkerRequest } from './types';
import { createWorkerCore } from './worker-core';
import { createWorkerDownloader, type WorkerLike } from './worker-downloader';

const BODY = Uint8Array.from({ length: 10 }, (_, i) => i);

function memSink() {
  let data = new Uint8Array(0);
  const sink: Sink = {
    flush: () => undefined,
    size: () => data.length,
    truncate: n => {
      const next = new Uint8Array(n);
      next.set(data.subarray(0, n));
      data = next;
    },
    write: (chunk, at) => {
      if (data.length < at + chunk.length) sink.truncate(at + chunk.length);
      data.set(chunk, at);
    },
  };
  return { get data() { return data; }, sink };
}

const start = (trackId = '1', offset = 0): WorkerRequest => ({ etag: null, headers: {}, offset, trackId, type: 'start', url: '/x' });

function setup(over: { fetch?: (u: string, i: RequestInit) => Promise<Response>; openSink?: (id: string) => Promise<{ sink: Sink; close(): void }> } = {}) {
  const posted: DownloadMessage[] = [];
  const closed: string[] = [];
  const mem = memSink();
  const core = createWorkerCore({
    fetch: over.fetch ?? (async () => new Response(BODY, { headers: { 'content-length': '10' } })),
    openSink: over.openSink ?? (async id => ({ close: () => void closed.push(id), sink: mem.sink })),
    post: m => void posted.push(m),
  });
  return { closed, core, mem, posted };
}

describe('ядро воркера скачивания', () => {
  it('скачивает файл, сообщает done и освобождает файл', async () => {
    const { closed, core, mem, posted } = setup();
    core.handle(start());
    await core.idle();
    expect(posted).toEqual([{ bytes: 10, etag: null, mime: 'application/octet-stream', resumable: false, trackId: '1', type: 'done' }]);
    expect(mem.data).toEqual(BODY);
    expect(closed).toEqual(['1']);
  });

  it('ошибка сервера → error с кодом и признаком повтора', async () => {
    const { core, posted } = setup({ fetch: async () => new Response('x', { status: 503 }) });
    core.handle(start());
    await core.idle();
    expect(posted).toEqual([{ bytesDone: 0, code: 'http_status', retryable: true, trackId: '1', type: 'error' }]);
  });

  it('отмена ничего не сообщает, файл закрывается', async () => {
    let release: () => void = () => undefined;
    const { closed, core, posted } = setup({
      fetch: (_u, init) =>
        new Promise((_, reject) => {
          release = () => reject(new DOMException('a', 'AbortError'));
          init.signal?.addEventListener('abort', release);
        }),
    });
    core.handle(start());
    await vi.waitFor(() => expect(closed).toEqual([]));
    core.handle({ trackId: '1', type: 'abort' });
    await core.idle();
    // Отмена ничего не сообщает об ошибке; о том, что файл свободен, — отдельный сигнал.
    expect(posted).toEqual([{ trackId: '1', type: 'aborted' }]);
    expect(closed).toEqual(['1']);
    core.handle({ trackId: 'unknown', type: 'abort' }); // нет такой загрузки — не ошибка
  });

  it('повторный start того же трека ждёт освобождения файла прежней загрузкой', async () => {
    const order: string[] = [];
    let n = 0;
    const { core, posted } = setup({
      fetch: (_u, init) => {
        const id = ++n;
        order.push(`fetch${id}`);
        if (id === 1) return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))));
        return Promise.resolve(new Response(BODY, { headers: { 'content-length': '10' } }));
      },
      openSink: async () => {
        order.push('open');
        return { close: () => void order.push('close'), sink: memSink().sink };
      },
    });
    core.handle(start());
    await vi.waitFor(() => expect(order).toEqual(['open', 'fetch1']));
    core.handle(start());
    await core.idle();
    expect(order).toEqual(['open', 'fetch1', 'close', 'open', 'fetch2', 'close']);
    expect(posted.map(m => m.type)).toEqual(['aborted', 'done']);
  });

  it('файл не открывается: storage (повторяемая); квота — не повторяется', async () => {
    const a = setup({ openSink: () => Promise.reject(new Error('locked')) });
    a.core.handle(start());
    await a.core.idle();
    expect(a.posted).toEqual([{ bytesDone: 0, code: 'storage', retryable: true, trackId: '1', type: 'error' }]);
    const b = setup({ openSink: () => Promise.reject(new DOMException('q', 'QuotaExceededError')) });
    b.core.handle(start());
    await b.core.idle();
    expect(b.posted).toEqual([{ bytesDone: 0, code: 'quota', retryable: false, trackId: '1', type: 'error' }]);
  });
});

class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  terminated = false;
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  postMessage = (m: WorkerRequest) => void this.sent.push(m);
  terminate = () => void (this.terminated = true);
}

describe('worker-downloader', () => {
  const p = { etag: null, headers: {}, offset: 0, url: '/x' };

  it('создаёт воркер при первой загрузке, пересылает команды и сообщения; не фоновый', () => {
    const workers: FakeWorker[] = [];
    const d = createWorkerDownloader(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    expect(d.background).toBe(false);
    expect(workers).toHaveLength(0);
    const got: DownloadMessage[] = [];
    const off = d.on(m => got.push(m));
    d.start({ ...p, trackId: '1' });
    d.start({ ...p, trackId: '2' });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.sent.map(m => m.type)).toEqual(['start', 'start']);
    workers[0]!.onmessage?.({ data: { bytes: 1, etag: null, mime: 'a', resumable: false, trackId: '1', type: 'done' } });
    expect(got).toHaveLength(1);
    d.abort('2');
    d.abort('2'); // повторная отмена — не отправляется
    d.abort('1'); // загрузка уже завершилась
    expect(workers[0]!.sent.filter(m => m.type === 'abort')).toEqual([{ trackId: '2', type: 'abort' }]);
    off();
    workers[0]!.onmessage?.({ data: { bytes: 1, etag: null, mime: 'a', resumable: false, trackId: '2', type: 'done' } });
    expect(got).toHaveLength(1);
  });

  it('падение воркера: все загрузки получают повторяемую ошибку, следующий start создаёт воркер заново', () => {
    const workers: FakeWorker[] = [];
    const d = createWorkerDownloader(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    const got: DownloadMessage[] = [];
    d.on(m => got.push(m));
    d.start({ ...p, trackId: '1' });
    d.start({ ...p, trackId: '2' });
    workers[0]!.onerror?.(new Event('error'));
    expect(workers[0]!.terminated).toBe(true);
    expect(got.map(m => m.type === 'error' && [m.trackId, m.code, m.retryable])).toEqual([
      ['1', 'storage', true],
      ['2', 'storage', true],
    ]);
    d.start({ ...p, trackId: '3' });
    expect(workers).toHaveLength(2);
  });

  it('abort до первого start ничего не делает', async () => {
    const d = createWorkerDownloader(() => new FakeWorker());
    await expect(d.abort('1')).resolves.toBeUndefined();
  });

  it('abort завершается, когда воркер подтвердил освобождение файла; подтверждение менеджеру не передаётся', async () => {
    const w = new FakeWorker();
    const d = createWorkerDownloader(() => w);
    const got: DownloadMessage[] = [];
    d.on(m => got.push(m));
    d.start({ ...p, trackId: '1' });
    let released = false;
    const pending = Promise.resolve(d.abort('1')).then(() => (released = true));
    await Promise.resolve();
    expect(released).toBe(false);
    w.onmessage?.({ data: { trackId: '1', type: 'aborted' } });
    await pending;
    expect(released).toBe(true);
    expect(got).toEqual([]);
  });

  it('воркер упал во время отмены — отмена всё равно завершается', async () => {
    const w = new FakeWorker();
    const d = createWorkerDownloader(() => w);
    d.start({ ...p, trackId: '1' });
    d.start({ ...p, trackId: '2' });
    const pending = d.abort('1');
    w.onerror?.(new Event('error'));
    await expect(pending).resolves.toBeUndefined();
  });
});
