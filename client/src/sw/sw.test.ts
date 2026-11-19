import { describe, expect, it, vi } from 'vitest';
import {
  cacheFirst,
  IMAGE_CACHE,
  isCacheable,
  isNegativeEntry,
  NEGATIVE_TTL_MS,
  staleImageCaches,
  staleWhileRevalidate,
  trimCache,
  type CacheLike,
} from './cache';
import { classifyRequest, type RequestInfo } from './classify';

const ORIGIN = 'https://nimbus.test';
const req = (url: string, over: Partial<RequestInfo> = {}): RequestInfo => ({
  destination: '',
  method: 'GET',
  mode: 'cors',
  range: false,
  url,
  ...over,
});

describe('classifyRequest', () => {
  it('навигация по приложению — оболочка', () => {
    expect(classifyRequest(req(`${ORIGIN}/album/5`, { mode: 'navigate' }), ORIGIN)).toBe('shell');
    expect(classifyRequest(req(`${ORIGIN}/`, { mode: 'navigate' }), ORIGIN)).toBe('shell');
  });

  it('навигация на /api/ и на чужой origin — не перехватывается', () => {
    expect(classifyRequest(req(`${ORIGIN}/api/export`, { mode: 'navigate' }), ORIGIN)).toBe('passthrough');
    expect(classifyRequest(req('https://other.test/x', { mode: 'navigate' }), ORIGIN)).toBe('passthrough');
  });

  it('обложки и фото артистов — кэш изображений', () => {
    const image = { destination: 'image' };
    expect(classifyRequest(req('https://coverartarchive.org/release/1/front', image), ORIGIN)).toBe('image');
    expect(classifyRequest(req('https://ia800.us.archive.org/1/items/x.jpg', image), ORIGIN)).toBe('image');
    expect(classifyRequest(req(`${ORIGIN}/api/artist-image/abc`, image), ORIGIN)).toBe('image');
    expect(classifyRequest(req('https://evil.test/api/artist-image/abc', image), ORIGIN)).toBe('passthrough');
    expect(classifyRequest(req(`${ORIGIN}/api/covers/release-group/abc/250`, image), ORIGIN)).toBe('image');
    expect(classifyRequest(req('https://notarchive.org.evil.test/x.jpg', image), ORIGIN)).toBe('passthrough');
    expect(classifyRequest(req(`${ORIGIN}/icons/icon.svg`, image), ORIGIN)).toBe('passthrough');
  });

  it('остальной /api/, поток аудио и Range — сеть', () => {
    expect(classifyRequest(req(`${ORIGIN}/api/library`), ORIGIN)).toBe('passthrough');
    expect(classifyRequest(req(`${ORIGIN}/api/tracks/5/stream`, { destination: 'audio' }), ORIGIN)).toBe('passthrough');
    expect(classifyRequest(req(`${ORIGIN}/api/artist-image/abc`, { destination: 'image', range: true }), ORIGIN)).toBe(
      'passthrough',
    );
    expect(classifyRequest(req(`${ORIGIN}/album/5`, { mode: 'navigate', range: true }), ORIGIN)).toBe('passthrough');
  });

  it('не-GET и мусорный адрес — сеть', () => {
    expect(classifyRequest(req(`${ORIGIN}/`, { method: 'POST', mode: 'navigate' }), ORIGIN)).toBe('passthrough');
    expect(classifyRequest(req('not a url'), ORIGIN)).toBe('passthrough');
  });

  it('необязательные словари — stale-while-revalidate, английский (в основном бандле) и прочие чанки — нет', () => {
    expect(classifyRequest(req(`${ORIGIN}/assets/ru-CNZE3PAM.js`), ORIGIN)).toBe('dictionary');
    expect(classifyRequest(req(`${ORIGIN}/assets/zh-IsqIEy4S.js`), ORIGIN)).toBe('dictionary');
    expect(classifyRequest(req(`${ORIGIN}/assets/en-abc.js`), ORIGIN)).toBe('passthrough');
    expect(classifyRequest(req(`${ORIGIN}/assets/index-Bxq.js`), ORIGIN)).toBe('passthrough');
    expect(classifyRequest(req('https://cdn.test/assets/ru-CNZE3PAM.js'), ORIGIN)).toBe('passthrough');
  });
});

function fakeCache(): CacheLike & { map: Map<string, Response> } {
  const map = new Map<string, Response>();
  return {
    delete: async r => map.delete(r.url),
    keys: async () => [...map.keys()].map(url => new Request(url)),
    map,
    match: async r => map.get(r.url)?.clone(),
    put: async (r, res) => void map.set(r.url, res),
  };
}
const imageRequest = (n: number | string) => new Request(`https://coverartarchive.org/release/${n}/front`);
const okResponse = () => new Response('img', { status: 200 });

describe('кэш изображений', () => {
  it('попадание: сеть не вызывается', async () => {
    const cache = fakeCache();
    cache.map.set(imageRequest(1).url, okResponse());
    const fetcher = vi.fn();
    const res = await cacheFirst(imageRequest(1), cache, fetcher, { max: 10 });
    expect(await res.text()).toBe('img');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('поиск в кэше игнорирует Vary (запрос модуля с Origin и cache.add без него — одна запись)', async () => {
    const cache = fakeCache();
    const match = vi.spyOn(cache, 'match');
    await cacheFirst(imageRequest(1), cache, async () => okResponse(), { max: 10 });
    await staleWhileRevalidate(imageRequest(1), cache, async () => okResponse());
    expect(match.mock.calls.every(([, options]) => options?.ignoreVary === true)).toBe(true);
    expect(match).toHaveBeenCalledTimes(2);
  });

  it('промах: ответ из сети записывается', async () => {
    const cache = fakeCache();
    const pending: Promise<unknown>[] = [];
    const res = await cacheFirst(
      imageRequest(1),
      cache,
      async () => okResponse(),
      { max: 10 },
      p => pending.push(p),
    );
    await Promise.all(pending);
    expect(await res.text()).toBe('img');
    expect(cache.map.has(imageRequest(1).url)).toBe(true);
  });

  it('404 не пишется', async () => {
    const cache = fakeCache();
    const pending: Promise<unknown>[] = [];
    await cacheFirst(
      imageRequest(2),
      cache,
      async () => new Response('', { status: 404 }),
      { max: 10 },
      p => pending.push(p),
    );
    expect(pending).toHaveLength(0);
    expect(cache.map.size).toBe(0);
    const opaque = { clone: () => opaque, ok: false, type: 'opaque' } as unknown as Response;
    expect(isCacheable(opaque)).toBe(false);
    expect(isCacheable(new Response('', { status: 500 }))).toBe(false);
  });

  it('404 с кодом не no_image не запоминается даже для фото артиста', async () => {
    const cache = fakeCache();
    const pending: Promise<unknown>[] = [];
    await cacheFirst(
      imageRequest(2),
      cache,
      async () => new Response(JSON.stringify({ code: 'mb_not_found' }), { status: 404 }),
      { negative: true },
      p => pending.push(p),
    );
    expect(pending).toHaveLength(0);
    expect(cache.map.size).toBe(0);
  });

  it('404 no_image запоминается на сутки и отдаётся из кэша без сети', async () => {
    const cache = fakeCache();
    const pending: Promise<unknown>[] = [];
    let t = 1_000_000;
    const noImage = () => new Response(JSON.stringify({ code: 'no_image' }), { status: 404 });
    const fetcher = vi.fn(async () => noImage());
    const run = () =>
      cacheFirst(imageRequest(7), cache, fetcher, { negative: true, now: () => t }, p => pending.push(p));

    const first = await run();
    await Promise.all(pending);
    expect(first.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);

    t += NEGATIVE_TTL_MS - 1;
    const again = await run();
    expect(again.status).toBe(404);
    expect((await again.json()).code).toBe('no_image');
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Срок вышел: запись удаляется, бэкенд спрашивается заново.
    t += 2;
    await run();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('просроченный «нет фото» заменяется картинкой, когда она появилась', async () => {
    const cache = fakeCache();
    let t = 0;
    const pending: Promise<unknown>[] = [];
    await cacheFirst(
      imageRequest(8),
      cache,
      async () => new Response(JSON.stringify({ code: 'no_image' }), { status: 404 }),
      { negative: true, now: () => t },
      p => pending.push(p),
    );
    await Promise.all(pending);
    t = NEGATIVE_TTL_MS + 1;
    const res = await cacheFirst(
      imageRequest(8),
      cache,
      async () => okResponse(),
      { negative: true, now: () => t },
      p => pending.push(p),
    );
    await Promise.all(pending);
    expect(res.status).toBe(200);
    expect(isNegativeEntry(cache.map.get(imageRequest(8).url) as Response)).toBe(false);
  });

  it('без опции negative 404 no_image не пишется (обложки)', async () => {
    const cache = fakeCache();
    const pending: Promise<unknown>[] = [];
    await cacheFirst(
      imageRequest(9),
      cache,
      async () => new Response(JSON.stringify({ code: 'no_image' }), { status: 404 }),
      {},
      p => pending.push(p),
    );
    expect(cache.map.size).toBe(0);
  });

  it('вытеснение сверх лимита: остаются самые новые', async () => {
    const cache = fakeCache();
    for (let i = 1; i <= 5; i++) cache.map.set(imageRequest(i).url, okResponse());
    await trimCache(cache, 3);
    expect([...cache.map.keys()].map(u => u.split('/')[4])).toEqual(['3', '4', '5']);
    await trimCache(cache, 10);
    expect(cache.map.size).toBe(3);
  });

  it('запись нового ответа вытесняет старейший при полном кэше', async () => {
    const cache = fakeCache();
    cache.map.set(imageRequest(1).url, okResponse());
    cache.map.set(imageRequest(2).url, okResponse());
    const pending: Promise<unknown>[] = [];
    await cacheFirst(
      imageRequest(3),
      cache,
      async () => okResponse(),
      { max: 2 },
      p => pending.push(p),
    );
    await Promise.all(pending);
    expect(cache.map.has(imageRequest(1).url)).toBe(false);
    expect(cache.map.size).toBe(2);
  });

  it('без лимита записи не вытесняются; старые кэши (в том числе nimbus-images-v1 прежнего sw.js) чистятся', async () => {
    const cache = fakeCache();
    for (let i = 0; i < 50; i++) await cacheFirst(imageRequest(i), cache, async () => okResponse());
    expect(cache.map.size).toBe(50);
    expect(staleImageCaches(['nimbus-images-v1', IMAGE_CACHE, 'workbox-precache-v2-x', 'nimbus-images-v0'])).toEqual([
      'nimbus-images-v1',
      'nimbus-images-v0',
    ]);
  });
});

describe('staleWhileRevalidate', () => {
  const dict = () => new Request(`${ORIGIN}/assets/ru-x.js`);

  it('есть кэш: отдаёт его сразу и обновляет в фоне', async () => {
    const cache = fakeCache();
    cache.map.set(dict().url, new Response('old'));
    const pending: Promise<unknown>[] = [];
    const res = await staleWhileRevalidate(
      dict(),
      cache,
      async () => new Response('new'),
      p => pending.push(p),
    );
    expect(await res.text()).toBe('old');
    await Promise.all(pending);
    expect(await cache.map.get(dict().url)!.text()).toBe('new');
  });

  it('нет кэша: ждёт сеть и записывает; ошибочный ответ не пишется', async () => {
    const cache = fakeCache();
    const res = await staleWhileRevalidate(dict(), cache, async () => new Response('fresh'));
    expect(await res.text()).toBe('fresh');
    expect(cache.map.size).toBe(1);
    const other = fakeCache();
    await staleWhileRevalidate(dict(), other, async () => new Response('', { status: 500 }));
    expect(other.map.size).toBe(0);
  });

  it('есть кэш, сети нет: кэш отдан, сбой фонового обновления проглочен', async () => {
    const cache = fakeCache();
    cache.map.set(dict().url, new Response('old'));
    const pending: Promise<unknown>[] = [];
    const res = await staleWhileRevalidate(
      dict(),
      cache,
      () => Promise.reject(new TypeError('offline')),
      p => pending.push(p),
    );
    expect(await res.text()).toBe('old');
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});
