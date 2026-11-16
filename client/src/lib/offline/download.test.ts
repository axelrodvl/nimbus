import { describe, expect, it, vi } from 'vitest';
import { downloadTo, FLUSH_EVERY_BYTES, PROGRESS_INTERVAL_MS, type Sink } from './download';

class MemSink implements Sink {
  data: Uint8Array = new Uint8Array(0);
  flushes = 0;
  failAfter = Infinity;
  constructor(initial: Uint8Array = new Uint8Array(0)) {
    this.data = initial;
  }
  size = () => this.data.length;
  truncate = (n: number) => {
    const next = new Uint8Array(n);
    next.set(this.data.subarray(0, n));
    this.data = next;
  };
  write = (chunk: Uint8Array, at: number) => {
    if (at + chunk.length > this.failAfter) throw new DOMException('full', 'QuotaExceededError');
    if (this.data.length < at + chunk.length) this.truncate(at + chunk.length);
    this.data.set(chunk, at);
  };
  flush = () => void this.flushes++;
}

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251);

/** Ответ с телом по частям; `breakAfter` — обрыв потока после стольких байтов. */
function response(
  body: Uint8Array,
  init: { status?: number; headers?: Record<string, string>; chunk?: number; breakAfter?: number } = {},
): Response {
  const chunk = init.chunk ?? 4;
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (init.breakAfter !== undefined && at >= init.breakAfter) {
        ctl.error(new TypeError('network error'));
        return;
      }
      if (at >= body.length) {
        ctl.close();
        return;
      }
      const end = Math.min(body.length, at + chunk, init.breakAfter ?? Infinity);
      ctl.enqueue(body.subarray(at, end));
      at = end;
    },
  });
  return new Response(stream, { headers: init.headers, status: init.status ?? 200 });
}

const FULL = bytes(20);
const rangeHeaders = { 'accept-ranges': 'bytes', 'content-type': 'audio/flac', etag: '"v1"' };
const base = { etag: null, headers: {}, offset: 0, url: '/api/tracks/1/stream?download=1' };

describe('downloadTo', () => {
  it('200: пишет файл целиком, определяет размер, тип и возможность докачки', async () => {
    const sink = new MemSink(bytes(5, 9));
    const fetchFn = vi.fn(async () => response(FULL, { headers: { ...rangeHeaders, 'content-length': '20' } }));
    const res = await downloadTo(sink, fetchFn, { ...base, headers: { 'x-a': '1' } });
    expect(res).toMatchObject({
      bytes: 20,
      bytesTotal: 20,
      etag: '"v1"',
      mime: 'audio/flac',
      ok: true,
      resumable: true,
    });
    expect(sink.data).toEqual(FULL);
    expect(sink.flushes).toBeGreaterThan(0);
    expect(fetchFn).toHaveBeenCalledWith(base.url, {
      credentials: 'include',
      headers: { 'x-a': '1' },
      signal: expect.any(AbortSignal),
    });
  });

  it('206: докачка с нужными Range и If-Range, дописывает с offset', async () => {
    const sink = new MemSink(FULL.slice(0, 8));
    const fetchFn = vi.fn(async (_u: string, _i: RequestInit) =>
      response(FULL.slice(8), {
        headers: { ...rangeHeaders, 'content-length': '12', 'content-range': 'bytes 8-19/20' },
        status: 206,
      }),
    );
    const res = await downloadTo(sink, fetchFn, { ...base, etag: '"v1"', offset: 8 });
    expect(res.ok).toBe(true);
    expect(sink.data).toEqual(FULL);
    const headers = fetchFn.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers).toMatchObject({ 'If-Range': '"v1"', Range: 'bytes=8-' });
  });

  it('206 без ETag у клиента: If-Range не отправляется; общий размер — из Content-Length, если нет Content-Range', async () => {
    const sink = new MemSink(FULL.slice(0, 8));
    const fetchFn = vi.fn(async (_u: string, _i: RequestInit) =>
      response(FULL.slice(8), { headers: { 'content-length': '12' }, status: 206 }),
    );
    const res = await downloadTo(sink, fetchFn, { ...base, offset: 8 });
    expect(res).toMatchObject({ bytesTotal: 20, ok: true, resumable: false });
    expect(Object.keys(fetchFn.mock.calls[0]![1].headers as object)).not.toContain('If-Range');
  });

  it('сервер проигнорировал Range (200): файл переписывается с нуля', async () => {
    const sink = new MemSink(bytes(12, 3));
    const res = await downloadTo(sink, async () => response(FULL, { headers: { 'content-length': '20' } }), {
      ...base,
      offset: 12,
    });
    expect(res.ok).toBe(true);
    expect(sink.data).toEqual(FULL);
  });

  it('206, но начало файла потеряно: ошибка incomplete, файл усечён — следующая попытка с нуля', async () => {
    const sink = new MemSink(FULL.slice(0, 3));
    const res = await downloadTo(
      sink,
      async () =>
        response(FULL.slice(8), { headers: { 'content-length': '12', 'content-range': 'bytes 8-19/20' }, status: 206 }),
      { ...base, offset: 8 },
    );
    expect(res).toEqual({ bytesDone: 0, code: 'incomplete', ok: false, retryable: true });
    expect(sink.size()).toBe(0);
  });

  it('206 с другого места или с другим ETag: данные не склеиваются, файл усечён, следующая попытка — с нуля', async () => {
    const otherStart = new MemSink(FULL.slice(0, 8));
    const a = await downloadTo(
      otherStart,
      async () =>
        response(FULL.slice(4), { headers: { 'content-length': '16', 'content-range': 'bytes 4-19/20' }, status: 206 }),
      { ...base, etag: '"v1"', offset: 8 },
    );
    expect(a).toEqual({ bytesDone: 0, code: 'incomplete', ok: false, retryable: true });
    expect(otherStart.size()).toBe(0);
    const otherVersion = new MemSink(FULL.slice(0, 8));
    const b = await downloadTo(
      otherVersion,
      async () =>
        response(FULL.slice(8), {
          headers: { 'content-length': '12', 'content-range': 'bytes 8-19/20', etag: '"v2"' },
          status: 206,
        }),
      { ...base, etag: '"v1"', offset: 8 },
    );
    expect(b).toMatchObject({ bytesDone: 0, code: 'incomplete', ok: false });
    expect(otherVersion.size()).toBe(0);
  });

  it('416: файл уже полный — успех; не совпадает — усечение и повтор с нуля', async () => {
    const full = new MemSink(FULL);
    const ok = await downloadTo(
      full,
      async () => new Response(null, { headers: { 'content-range': 'bytes */20' }, status: 416 }),
      { ...base, etag: '"v1"', offset: 20 },
    );
    expect(ok).toMatchObject({ bytes: 20, etag: '"v1"', ok: true });
    const wrong = new MemSink(FULL.slice(0, 10));
    const bad = await downloadTo(
      wrong,
      async () => new Response(null, { headers: { 'content-range': 'bytes */30' }, status: 416 }),
      { ...base, offset: 10 },
    );
    expect(bad).toEqual({ bytesDone: 0, code: 'incomplete', ok: false, retryable: true });
    expect(wrong.size()).toBe(0);
  });

  it('обрыв потока посередине: retryable, bytesDone — записанное и сброшенное на диск', async () => {
    const sink = new MemSink();
    const res = await downloadTo(
      sink,
      async () => response(FULL, { breakAfter: 10, headers: { ...rangeHeaders, 'content-length': '20' } }),
      base,
    );
    expect(res).toEqual({
      bytesDone: 10,
      code: 'network',
      info: { bytesDone: 10, bytesTotal: 20, etag: '"v1"', mime: 'audio/flac', resumable: true },
      ok: false,
      retryable: true,
    });
    expect(sink.data.subarray(0, 10)).toEqual(FULL.subarray(0, 10));
  });

  it('поток без Content-Length (перекодируемый): размер неизвестен, докачка невозможна', async () => {
    const res = await downloadTo(
      new MemSink(),
      async () => response(FULL, { headers: { 'content-type': 'audio/wav' } }),
      base,
    );
    expect(res).toMatchObject({ bytes: 20, bytesTotal: 20, mime: 'audio/wav', ok: true, resumable: false });
  });

  it('тип по умолчанию, если сервер не прислал Content-Type', async () => {
    const res = await downloadTo(new MemSink(), async () => response(FULL), base);
    expect(res).toMatchObject({ mime: 'application/octet-stream', ok: true });
  });

  it('размер не совпал с Content-Length: incomplete (повторяемая)', async () => {
    const res = await downloadTo(
      new MemSink(),
      async () => response(FULL.slice(0, 15), { headers: { 'content-length': '20' } }),
      base,
    );
    expect(res).toMatchObject({
      bytesDone: 15,
      code: 'incomplete',
      info: { bytesTotal: 20, resumable: false },
      ok: false,
      retryable: true,
    });
  });

  it.each([
    [401, 'unauthorized', false],
    [404, 'not_found', false],
    [410, 'not_found', false],
    [403, 'http_status', false],
    [409, 'http_status', true],
    [429, 'http_status', true],
    [500, 'http_status', true],
    [503, 'http_status', true],
  ])('HTTP %i → %s (retryable=%s)', async (status, code, retryable) => {
    const res = await downloadTo(new MemSink(), async () => new Response('x', { status }), { ...base, offset: 0 });
    expect(res).toEqual({ bytesDone: 0, code, ok: false, retryable });
  });

  it('сеть недоступна: network, retryable; bytesDone — смещение запроса', async () => {
    const res = await downloadTo(new MemSink(FULL.slice(0, 4)), () => Promise.reject(new TypeError('offline')), {
      ...base,
      offset: 4,
    });
    expect(res).toEqual({ bytesDone: 4, code: 'network', ok: false, retryable: true });
  });

  it('тело отсутствует: network', async () => {
    const res = await downloadTo(
      new MemSink(),
      async () => ({ headers: new Headers(), ok: true, status: 200 }) as Response,
      base,
    );
    expect(res).toMatchObject({ code: 'network', ok: false });
  });

  it('нет места на диске при записи: quota, не повторяется', async () => {
    const sink = new MemSink();
    sink.failAfter = 8;
    const res = await downloadTo(sink, async () => response(FULL, { headers: { 'content-length': '20' } }), base);
    expect(res).toMatchObject({ code: 'quota', ok: false, retryable: false });
  });

  it('QuotaExceededError от fetch: quota', async () => {
    const res = await downloadTo(
      new MemSink(),
      () => Promise.reject(new DOMException('q', 'QuotaExceededError')),
      base,
    );
    expect(res).toMatchObject({ code: 'quota', retryable: false });
  });

  it('иная ошибка записи: storage, повторяемая', async () => {
    const sink = new MemSink();
    sink.write = () => {
      throw new Error('disk');
    };
    const res = await downloadTo(sink, async () => response(FULL, { headers: { 'content-length': '20' } }), base);
    expect(res).toMatchObject({ code: 'storage', ok: false, retryable: true });
  });

  it('отмена: aborted, не повторяется; уже отменённый сигнал — сразу', async () => {
    const ctl = new AbortController();
    const sink = new MemSink();
    const fetchFn = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))),
      );
    const pending = downloadTo(sink, fetchFn, { ...base, signal: ctl.signal });
    ctl.abort();
    expect(await pending).toMatchObject({ code: 'aborted', ok: false, retryable: false });
    expect(await downloadTo(sink, fetchFn, { ...base, signal: ctl.signal })).toMatchObject({ code: 'aborted' });
  });

  it('отмена во время чтения тела: aborted', async () => {
    const ctl = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const pending = downloadTo(
      new MemSink(),
      async () => new Response(stream, { headers: { 'content-length': '20' } }),
      {
        ...base,
        signal: ctl.signal,
      },
    );
    await new Promise(r => setTimeout(r, 0));
    ctl.abort();
    expect(await pending).toMatchObject({ code: 'aborted', ok: false, retryable: false });
  });

  it('простой без данных дольше таймаута: timeout, повторяемая', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = (_u: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))),
        );
      const pending = downloadTo(new MemSink(), fetchFn, { ...base, idleTimeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toEqual({ bytesDone: 0, code: 'timeout', ok: false, retryable: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('прогресс — не чаще раза в 250 мс; flush каждые ~4 МБ', async () => {
    let t = 0;
    const onProgress = vi.fn();
    const sink = new MemSink();
    const big = bytes(FLUSH_EVERY_BYTES + 10);
    const res = await downloadTo(
      sink,
      async () => response(big, { chunk: FLUSH_EVERY_BYTES / 2, headers: { 'content-length': String(big.length) } }),
      {
        ...base,
        now: () => (t += PROGRESS_INTERVAL_MS / 2),
        onProgress,
      },
    );
    expect(res.ok).toBe(true);
    // Шаг часов — половина интервала: сообщение приходит на каждом втором чтении.
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(onProgress.mock.calls[0]![0]).toMatchObject({ bytesTotal: big.length });
    expect(sink.flushes).toBeGreaterThanOrEqual(2);
  });
});
