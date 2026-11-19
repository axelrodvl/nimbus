import { describe, expect, it, vi } from 'vitest';
import { makeAlbum, makeArtist } from '@/test/factories';
import type { CacheLike } from '@/sw/cache';
import { runWarm, warmTargets, type WarmDeps } from './warm';

function fakeCache(initial: string[] = []): CacheLike & { map: Map<string, Response> } {
  const map = new Map<string, Response>(initial.map(u => [new Request(u).url, new Response('x')]));
  return {
    delete: async r => map.delete(r.url),
    keys: async () => [...map.keys()].map(u => new Request(u)),
    map,
    match: async r => map.get(r.url)?.clone(),
    put: async (r, res) => void map.set(r.url, res),
  };
}

const urls = (n: number) =>
  Array.from({ length: n }, (_, i) => `https://nimbus.test/api/covers/release-group/${i}/250`);

function deps(over: Partial<WarmDeps> = {}): WarmDeps & { fetch: ReturnType<typeof vi.fn> } {
  return {
    cache: fakeCache(),
    enabled: () => true,
    fetch: vi.fn(async () => new Response('img')),
    paused: () => false,
    saveData: () => false,
    sleep: async () => undefined,
    ...over,
  } as WarmDeps & { fetch: ReturnType<typeof vi.fn> };
}

describe('warmTargets', () => {
  it('фото — только у артистов библиотеки с image = yes; обложки — свежие альбомы библиотеки, не больше лимита', () => {
    const artists = [
      makeArtist({ id: 1, image: 'yes', mbid: 'a1' }),
      makeArtist({ id: 2, image: 'no', mbid: 'a2' }),
      makeArtist({ id: 3, image: null, mbid: 'a3' }),
      makeArtist({ id: 4, image: 'yes', in_library: false, mbid: 'a4' }),
    ];
    const caa = (n: string) =>
      `https://coverartarchive.org/release-group/00000000-0000-0000-0000-00000000000${n}/front-250`;
    const albums = [
      makeAlbum({ added_at: '2026-01-01T00:00:00Z', cover_url: caa('1'), id: 1 }),
      makeAlbum({ added_at: '2026-03-01T00:00:00Z', cover_url: caa('2'), id: 2 }),
      makeAlbum({ added_at: '2026-02-01T00:00:00Z', cover_url: null, id: 3 }),
      makeAlbum({ added_at: '2026-04-01T00:00:00Z', cover_url: caa('4'), id: 4, in_library: false }),
    ];
    const out = warmTargets(artists, albums, 2);
    expect(out).toEqual([
      '/api/artist-image/a1',
      '/api/covers/release-group/00000000-0000-0000-0000-000000000002/250',
      '/api/covers/release-group/00000000-0000-0000-0000-000000000001/250',
    ]);
  });
});

describe('runWarm', () => {
  it('закэшированное пропускается (продолжение после перезапуска), остальное загружается и пишется', async () => {
    const list = urls(4);
    const cache = fakeCache([list[0] as string, list[2] as string]);
    const d = deps({ cache });
    const res = await runWarm(list, d);
    expect(d.fetch).toHaveBeenCalledTimes(2);
    expect(cache.map.size).toBe(4);
    expect(res).toEqual({ state: 'done', total: 4, warmed: 4 });
  });

  it('не более заданного числа запросов одновременно', async () => {
    let active = 0;
    let peak = 0;
    const d = deps({
      concurrency: 2,
      fetch: vi.fn(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 1));
        active--;
        return new Response('img');
      }),
    });
    await runWarm(urls(10), d);
    expect(peak).toBe(2);
    expect(d.fetch).toHaveBeenCalledTimes(10);
  });

  it('saveData: ничего не загружается', async () => {
    const d = deps({ saveData: () => true });
    const res = await runWarm(urls(5), d);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(res.state).toBe('stopped');
  });

  it('saveData включили посреди прогрева: останавливается', async () => {
    let on = false;
    const d = deps({
      fetch: vi.fn(async () => {
        on = true;
        return new Response('img');
      }),
      saveData: () => on,
    });
    const res = await runWarm(urls(10), d);
    expect(res.state).toBe('stopped');
    expect(d.fetch.mock.calls.length).toBeLessThan(10);
  });

  it('пауза (стрим, навигация): ждёт без загрузок, затем продолжает', async () => {
    let paused = true;
    const sleeps: number[] = [];
    const d = deps({
      paused: () => paused,
      sleep: async ms => {
        sleeps.push(ms);
        if (sleeps.length === 3) paused = false;
      },
    });
    const states: string[] = [];
    const res = await runWarm(urls(3), { ...d, onProgress: p => states.push(p.state) });
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
    expect(d.fetch).toHaveBeenCalledTimes(3);
    expect(states).toContain('paused');
    expect(res.state).toBe('done');
  });

  it('сигнал остановки и выключенная настройка прекращают прогрев', async () => {
    const ctl = new AbortController();
    const d = deps({
      fetch: vi.fn(async () => {
        ctl.abort();
        return new Response('img');
      }),
      signal: ctl.signal,
    });
    expect((await runWarm(urls(10), d)).state).toBe('stopped');
    const off = deps({ enabled: () => false });
    await runWarm(urls(3), off);
    expect(off.fetch).not.toHaveBeenCalled();
  });

  it('ошибка и не-ok ответ одной картинки не мешают остальным и не пишутся', async () => {
    const list = urls(3);
    const cache = fakeCache();
    const d = deps({
      cache,
      fetch: vi.fn(async (u: string) => {
        if (u === list[0]) throw new Error('network');
        if (u === list[1]) return new Response('', { status: 404 });
        return new Response('img');
      }),
    });
    const res = await runWarm(list, d);
    expect(cache.map.size).toBe(1);
    expect(res).toEqual({ state: 'done', total: 3, warmed: 1 });
  });
});
