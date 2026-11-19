import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { createSyncApi } from '@/lib/api/sync';
import { createDb, type Db } from '@/lib/db';
import { createLibraryStore } from '@/lib/store/library';
import { createLiveStore } from '@/lib/store/live';
import { FakeSyncServer, makeAlbum, makeArtist, makeLibrary, makeTrack, resetFactories } from '@/test/factories';
import { createSyncEngine, LIVE_FLUSH_MS, SAFETY_POLL_MS, SYNC_SCHEMA, type EngineDeps } from './engine';
import { createTabs, type ChannelLike, type LockManagerLike, type Tabs } from './tabs';

let n = 0;
let engines: ReturnType<typeof createSyncEngine>[] = [];

beforeEach(() => {
  resetFactories();
  engines = [];
});
afterEach(() => {
  engines.forEach(e => e.stop());
  vi.useRealTimers();
});

type Env = ReturnType<typeof makeEnv>;

function makeEnv(
  server: FakeSyncServer,
  opts: { dbName?: string; tabs?: Tabs; onUnauthorized?: () => void; db?: Db } = {},
) {
  const db = opts.db ?? createDb({ name: opts.dbName ?? `engine-test-${++n}` });
  const store = createLibraryStore();
  const live = createLiveStore();
  const client = createApiClient({ baseUrl: 'http://fake', fetch: server.fetch });
  const deps: EngineDeps = {
    api: createSyncApi(client),
    db,
    live,
    onUnauthorized: opts.onUnauthorized,
    random: () => 0.5, // джиттер ровно 1.0
    store,
    tabs: opts.tabs ?? createTabs({ channel: null, locks: null }),
  };
  const engine = createSyncEngine(deps);
  engines.push(engine);
  return { db, engine, live, store, state: () => engine.status.getState().state };
}

async function sync(env: Env) {
  await env.engine.start();
  await env.engine.settled();
}

const ids = (env: Env, kind: 'tracks' | 'albums' | 'artists' = 'tracks') =>
  [...env.store.getState()[kind].keys()].sort((a, b) => a - b);

describe('запуск', () => {
  it('первый запуск: снимок → live; данные в store и в IndexedDB, курсор сохранён', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 2, tracksPerAlbum: 2 }));
    const env = makeEnv(server);
    expect(env.state()).toBe('idle');
    await sync(env);
    expect(env.state()).toBe('live');
    expect(server.snapshotRequests).toBe(1);
    expect(server.changesRequests).toBe(0);
    expect(ids(env)).toEqual([1, 2, 3, 4]);
    expect(env.store.getState().hydrated).toBe(true);
    const saved = await env.db.loadAll();
    expect(saved.tracks).toHaveLength(4);
    expect(saved.meta).toMatchObject({ cursor: server.cursor, schema: SYNC_SCHEMA });
    expect(env.engine.status.getState().lastSyncedAt).not.toBeNull();
  });

  it('повторный запуск с курсором: данные из базы показываются сразу, дальше — дельта без снимка', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 }));
    const dbName = `engine-restart-${++n}`;
    const first = makeEnv(server, { dbName });
    await sync(first);
    first.engine.stop();

    server.upsert('track', makeTrack({ album_id: 1, artist_id: 1, id: 50 }));
    const second = makeEnv(server, { dbName });
    await second.engine.start();
    // Экран уже может рисовать: store гидрирован до сети.
    expect(second.store.getState().hydrated).toBe(true);
    expect(second.store.getState().tracks.size).toBeGreaterThanOrEqual(2);
    await second.engine.settled();
    expect(server.snapshotRequests).toBe(1);
    expect(server.changesRequests).toBe(1);
    expect(ids(second)).toEqual([1, 2, 50]);
    expect(second.state()).toBe('live');
  });

  it('курсор другой версии формата игнорируется — берётся снимок', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ artists: 1, albumsPerArtist: 1, tracksPerAlbum: 1 }));
    const dbName = `engine-schema-${++n}`;
    await createDb({ name: dbName }).applyBatch({ meta: { cursor: 'old', schema: 999 } });
    const env = makeEnv(server, { dbName });
    await sync(env);
    expect(server.snapshotRequests).toBe(1);
  });

  it.each([
    [1, 'до закреплений в треках, ревью S11'],
    [2, 'до признака фото артистов, ревью S12'],
    [3, 'до состояния импорта артистов, ревью S13'],
  ])('данные формата %i (%s) — берётся снимок', async schema => {
    const server = new FakeSyncServer().load(makeLibrary({ artists: 1, albumsPerArtist: 1, tracksPerAlbum: 1 }));
    const dbName = `engine-schema-v${schema}-${++n}`;
    await createDb({ name: dbName }).applyBatch({ meta: { cursor: `${schema}.e.5`, schema } });
    const env = makeEnv(server, { dbName });
    await sync(env);
    expect(server.snapshotRequests).toBe(1);
    expect((await createDb({ name: dbName }).loadMeta()).schema).toBe(SYNC_SCHEMA);
  });

  it('ошибка чтения базы: старт с чистого листа, данные приходят снимком', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ artists: 1, albumsPerArtist: 1, tracksPerAlbum: 1 }));
    const db = createDb({ name: `engine-broken-${++n}` });
    vi.spyOn(db, 'loadAll').mockRejectedValueOnce(new Error('corrupt'));
    const env = makeEnv(server, { db });
    await sync(env);
    expect(server.snapshotRequests).toBe(1);
    expect(env.store.getState().tracks.size).toBe(1);
  });

  it('start() повторно и после stop() безопасен', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ artists: 1, albumsPerArtist: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    await env.engine.start();
    env.engine.stop();
    env.engine.requestSync('after-stop');
    await env.engine.settled();
    expect(server.changesRequests).toBe(0);
  });
});

describe('дельта', () => {
  it('more: true дочитывается без пауз; итоговый курсор — актуальный', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    server.pageSize = 2;
    for (let i = 0; i < 5; i++) server.upsert('track', makeTrack({ album_id: 1, artist_id: 1, id: 100 + i }));
    env.engine.handleEvent({ type: 'sync.poke' });
    await env.engine.settled();
    // Повтор последней строки страницы допустим (курсор = txid последней строки), поэтому запросов больше трёх.
    expect(server.changesRequests).toBeGreaterThanOrEqual(3);
    expect(ids(env)).toEqual([1, 100, 101, 102, 103, 104]);
    expect((await env.db.loadMeta()).cursor).toBe(server.cursor);
  });

  it('изменения и удаления применяются; нет изменений — состояние не меняется', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 3 }));
    const env = makeEnv(server);
    await sync(env);
    const version = env.store.getState().version;
    env.engine.requestSync('noop');
    await env.engine.settled();
    expect(env.store.getState().version).toBe(version);

    server.upsert('track', { ...makeTrack({ album_id: 1, artist_id: 1, id: 1 }), title: 'Renamed' });
    server.remove('track', 2);
    env.engine.requestSync('change');
    await env.engine.settled();
    expect(env.store.getState().tracks.get(1)?.title).toBe('Renamed');
    expect(ids(env)).toEqual([1, 3]);
    expect((await env.db.loadAll()).tracks.map(t => t.id).sort()).toEqual([1, 3]);
  });

  it('повтор той же дельты не меняет состояние (сервер присылает уже известные строки)', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 }));
    const env = makeEnv(server);
    await sync(env);
    server.upsert('track', makeTrack({ album_id: 1, artist_id: 1, id: 9 }));
    env.engine.requestSync('a');
    await env.engine.settled();
    const plain = () => JSON.stringify([...env.store.getState().tracks.entries()].sort((a, b) => a[0] - b[0]));
    const once = plain();
    // Курсор «откатился» (например, долгая чужая транзакция держит xmin): те же строки приходят снова.
    server.cursorsSeen.length = 0;
    const real = server.cursor;
    server.txid -= 1;
    env.engine.requestSync('b');
    await env.engine.settled();
    server.txid = Number(real.split('.')[2]);
    expect(plain()).toBe(once);
  });

  it('reset от сервера → новый снимок', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    server.remove('track', 1);
    server.upsert('track', makeTrack({ album_id: 1, artist_id: 1, id: 77 }));
    server.resetNext = true;
    env.engine.handleEvent({ type: 'sync.poke' });
    await env.engine.settled();
    expect(server.snapshotRequests).toBe(2);
    expect(ids(env)).toEqual([77]);
  });

  it('resetAndResync забывает курсор и берёт снимок, в том числе во время работы', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    env.engine.resetAndResync();
    await env.engine.settled();
    expect(server.snapshotRequests).toBe(2);

    env.engine.requestSync('x');
    env.engine.resetAndResync();
    await env.engine.settled();
    expect(server.snapshotRequests).toBe(3);
  });
});

describe('снимок', () => {
  it('строки NDJSON, разорванные между чанками, собираются', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 2, artists: 2, tracksPerAlbum: 3 }));
    server.chunkSize = 7;
    const env = makeEnv(server);
    await sync(env);
    expect(ids(env)).toHaveLength(12);
    expect(env.state()).toBe('live');
  });

  it('многобайтовые символы, разрезанные границей чанка, не портятся', async () => {
    const server = new FakeSyncServer().load({
      albums: [makeAlbum({ artist_id: 1, id: 1, title: 'Ёлка 🎵 日本語' })],
      artists: [makeArtist({ id: 1, name: 'Björk' })],
    });
    server.chunkSize = 3;
    const env = makeEnv(server);
    await sync(env);
    expect(env.store.getState().albums.get(1)?.title).toBe('Ёлка 🎵 日本語');
  });

  it('оборванный снимок (нет end) не портит имеющиеся данные и повторяется', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 }));
    const env = makeEnv(server);
    await sync(env);
    const before = ids(env);

    server.upsert('track', makeTrack({ album_id: 1, artist_id: 1, id: 500 }));
    server.cutSnapshot = { afterLines: 3, mode: 'truncate' };
    env.engine.resetAndResync();
    await env.engine.settled();
    expect(env.state()).toBe('error');
    expect(ids(env)).toEqual(before);
    expect((await env.db.loadAll()).tracks.map(t => t.id).sort()).toEqual(before);

    server.cutSnapshot = null;
    await vi.advanceTimersByTimeAsync(1000);
    await env.engine.settled();
    expect(env.state()).toBe('live');
    expect(ids(env)).toContain(500);
    expect(server.snapshotRequests).toBe(3);
  });

  it('обрыв соединения посреди потока — ошибка сети, offline, данные целы', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 }));
    server.cutSnapshot = { afterLines: 3, mode: 'error' };
    const env = makeEnv(server);
    await sync(env);
    expect(env.state()).toBe('offline');
    expect(env.engine.status.getState().error).toMatchObject({ code: 'network' });
    expect(env.store.getState().tracks.size).toBe(0);
  });

  it('счётчики end не сошлись — снимок отброшен', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 }));
    server.corruptCounts = true;
    const env = makeEnv(server);
    await sync(env);
    expect(env.state()).toBe('error');
    expect(env.engine.status.getState().error?.message).toMatch(/count mismatch/);
    expect(env.store.getState().tracks.size).toBe(0);
  });

  it('мусорная строка в потоке — ошибка, данные не применены', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const real = server.fetch;
    server.fetch = async input => {
      const res = await real(input);
      if (!res.headers.get('content-type')?.includes('ndjson')) return res;
      return new Response(`${await res.text()}{broken\n`, { headers: res.headers });
    };
    const env = makeEnv(server);
    await sync(env);
    expect(env.state()).toBe('error');
    expect(env.engine.status.getState().error?.message).toMatch(/malformed/);
  });

  it('неизвестные типы строк и пустые строки игнорируются', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const real = server.fetch;
    server.fetch = async input => {
      const res = await real(input);
      if (!res.headers.get('content-type')?.includes('ndjson')) return res;
      const lines = (await res.text()).split('\n');
      lines.splice(1, 0, '', JSON.stringify({ type: 'future_entity', row: { id: 1 } }));
      return new Response(lines.join('\n'), { headers: res.headers });
    };
    const env = makeEnv(server);
    await sync(env);
    expect(env.state()).toBe('live');
    expect(env.store.getState().tracks.size).toBe(1);
  });

  it('прогресс снимка виден в статусе', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 2, artists: 20, tracksPerAlbum: 60 }));
    const env = makeEnv(server);
    const seen: number[] = [];
    env.engine.status.subscribe(s => {
      if (s.progress) seen.push(s.progress.received);
    });
    await sync(env);
    expect(seen.some(r => r >= 2000)).toBe(true);
    expect(env.engine.status.getState().progress).toBeNull();
  });
});

describe('одиночный полёт, ошибки и повторы', () => {
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

  it('5 requestSync подряд — не более 2 запросов', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    for (let i = 0; i < 5; i++) env.engine.requestSync('burst');
    await env.engine.settled();
    expect(server.changesRequests).toBeLessThanOrEqual(2);
    expect(server.changesRequests).toBeGreaterThanOrEqual(1);
  });

  it('503: пауза с экспоненциальным ростом и повтор', async () => {
    fakeTimers();
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    server.failures = [503, 503];
    const base = server.requests; // запросы снимка
    env.engine.requestSync('x');
    await env.engine.settled();
    expect(env.state()).toBe('error');
    expect(env.engine.status.getState().error).toMatchObject({ status: 503 });
    expect(server.requests - base).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(server.requests - base).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    await env.engine.settled();
    expect(server.requests - base).toBe(2); // второй отказ
    expect(env.state()).toBe('error');

    await vi.advanceTimersByTimeAsync(1900);
    expect(server.requests - base).toBe(2); // пауза выросла до 2 с
    await vi.advanceTimersByTimeAsync(200);
    await env.engine.settled();
    expect(server.requests - base).toBe(3);
    expect(env.state()).toBe('live');
    expect(env.engine.status.getState().error).toBeNull();
  });

  it('пауза не превышает 30 с', async () => {
    fakeTimers();
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    server.failures = Array.from({ length: 9 }, () => 500);
    env.engine.requestSync('x');
    await env.engine.settled();
    const base = server.requests;
    // Паузы: 1, 2, 4, 8, 16, затем не больше 30 с (± джиттер): за 6 × 30 с — все 10 попыток.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await env.engine.settled();
    }
    expect(server.requests - base).toBe(10);
    expect(env.state()).toBe('live');
  });

  it('сетевой сбой → offline; возврат сети (online) запускает повтор сразу', async () => {
    fakeTimers();
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    server.failures = ['network'];
    env.engine.requestSync('x');
    await env.engine.settled();
    expect(env.state()).toBe('offline');
    globalThis.dispatchEvent(new Event('online'));
    await env.engine.settled();
    expect(env.state()).toBe('live');
  });

  it('событие offline переводит состояние в offline', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    globalThis.dispatchEvent(new Event('offline'));
    expect(env.state()).toBe('offline');
  });

  it('401 → onUnauthorized и остановка: повторов нет', async () => {
    fakeTimers();
    const onUnauthorized = vi.fn();
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server, { onUnauthorized });
    await sync(env);
    server.failures = [401];
    env.engine.requestSync('x');
    await env.engine.settled();
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(env.state()).toBe('error');
    const requests = server.changesRequests;
    await vi.advanceTimersByTimeAsync(120_000);
    env.engine.requestSync('again');
    await env.engine.settled();
    expect(server.changesRequests).toBe(requests);
  });

  it('401 на первом снимке тоже останавливает движок', async () => {
    const onUnauthorized = vi.fn();
    const server = new FakeSyncServer();
    server.failures = [401];
    const env = makeEnv(server, { onUnauthorized });
    await sync(env);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('ошибка записи в IndexedDB — состояние error, store не уходит вперёд базы', async () => {
    fakeTimers();
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    const spy = vi.spyOn(env.db, 'applyBatch').mockRejectedValueOnce(new Error('quota'));
    server.upsert('track', makeTrack({ album_id: 1, artist_id: 1, id: 60 }));
    env.engine.requestSync('x');
    await env.engine.settled();
    expect(env.state()).toBe('error');
    expect(ids(env)).toEqual([1]);
    spy.mockRestore();
    await vi.advanceTimersByTimeAsync(1000);
    await env.engine.settled();
    expect(ids(env)).toEqual([1, 60]);
  });
});

describe('триггеры', () => {
  it('sync.poke и resync запускают дельту; прочие события — нет', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    env.engine.handleEvent({ type: 'acquisition.changed' });
    env.engine.handleEvent({ type: 'library.changed' });
    await env.engine.settled();
    expect(server.changesRequests).toBe(0);
    env.engine.handleEvent({ type: 'sync.poke' });
    await env.engine.settled();
    expect(server.changesRequests).toBe(1);
    env.engine.handleEvent({ type: 'resync' });
    await env.engine.settled();
    expect(server.changesRequests).toBe(2);
  });

  it('возврат вкладки на передний план запускает дельту, скрытая вкладка — нет', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await env.engine.settled();
    expect(server.changesRequests).toBe(0);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await env.engine.settled();
    expect(server.changesRequests).toBe(1);
  });

  it('страховочный таймер раз в 5 минут', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS - 1);
    expect(server.changesRequests).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    await env.engine.settled();
    expect(server.changesRequests).toBe(1);
  });
});

const status = (track_id: number, album_id: number, st: 'adding' | 'found' | 'not_found' | 'ready') =>
  ({ album_id, reason: null, status: st, track_id, type: 'track.status' }) as const;

describe('объединение live-событий', () => {
  async function bigEnv(tracks = 500, fake = true) {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: tracks }));
    const env = makeEnv(server);
    await sync(env);
    if (fake) vi.useFakeTimers();
    return { env, server };
  }

  it('coalesces track.status into one store update', async () => {
    const { env } = await bigEnv();
    const spy = vi.spyOn(env.db, 'patchTracks');
    let notified = 0;
    env.store.subscribe(() => (notified += 1));
    for (let id = 1; id <= 500; id++) env.engine.handleEvent(status(id, 1, 'not_found'));
    vi.advanceTimersByTime(LIVE_FLUSH_MS - 1);
    expect(notified).toBe(0);
    expect(env.store.getState().tracks.get(1)?.status).not.toBe('not_found');
    vi.advanceTimersByTime(1);
    expect(notified).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].size).toBe(500);
  });

  it('last status per track wins', async () => {
    const { env } = await bigEnv(2);
    env.engine.handleEvent(status(1, 1, 'adding'));
    env.engine.handleEvent(status(1, 1, 'not_found'));
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    expect(env.store.getState().tracks.get(1)?.status).toBe('not_found');
  });

  it('flushes pending patches before applying a delta', async () => {
    const { env, server } = await bigEnv(2, false);
    env.engine.handleEvent(status(1, 1, 'adding'));
    const track = env.store.getState().tracks.get(1);
    if (!track) throw new Error('no track');
    server.upsert('track', { ...track, status: 'found' });
    env.engine.handleEvent({ type: 'sync.poke' });
    await env.engine.settled();
    expect(env.store.getState().tracks.get(1)?.status).toBe('found');
    expect((await env.db.loadAll()).tracks.find(t => t.id === 1)?.status).toBe('found');
  });

  it('stop drops pending events', async () => {
    const { env } = await bigEnv(2);
    const before = env.store.getState().tracks.get(1)?.status;
    env.engine.handleEvent(status(1, 1, 'not_found'));
    env.engine.handleEvent({ album_id: 1, done: 1, stage: 'searching', total: 2, type: 'job.progress' });
    env.engine.stop();
    vi.advanceTimersByTime(LIVE_FLUSH_MS * 2);
    expect(env.store.getState().tracks.get(1)?.status).toBe(before);
    expect(env.live.getState().albumProgress.size).toBe(0);
  });

  it('clears album progress when the album has no adding tracks', async () => {
    const { env } = await bigEnv(2);
    env.engine.handleEvent(status(1, 1, 'adding'));
    env.engine.handleEvent({ album_id: 1, done: 1, stage: 'searching', total: 2, type: 'job.progress' });
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    expect(env.live.getState().albumProgress.has(1)).toBe(true);
    env.engine.handleEvent(status(1, 1, 'not_found'));
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    expect(env.live.getState().albumProgress.has(1)).toBe(false);
  });

  it('clears finished download progress', async () => {
    const { env } = await bigEnv(1);
    const ev = { album_id: 1, bytes_total: 10, down_bps: 1, peers: 1, type: 'download.progress' } as const;
    env.engine.handleEvent({ ...ev, bytes_done: 5 });
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    expect(env.live.getState().downloadProgress.has(1)).toBe(true);
    env.engine.handleEvent({ ...ev, bytes_done: 10 });
    vi.advanceTimersByTime(LIVE_FLUSH_MS);
    expect(env.live.getState().downloadProgress.has(1)).toBe(false);
  });
});

describe('мгновенные события', () => {
  it('track.status обновляет store и IndexedDB без дельты после окна объединения', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 }));
    const env = makeEnv(server);
    await sync(env);
    env.engine.handleEvent({ album_id: 1, reason: 'no seeds', status: 'not_found', track_id: 1, type: 'track.status' });
    await env.engine.settled();
    expect(env.store.getState().tracks.get(1)).toMatchObject({ status: 'not_found', status_reason: 'no seeds' });
    expect((await env.db.loadAll()).tracks[0]?.status).toBe('not_found');
    expect(server.changesRequests).toBe(0);
  });

  it('job.progress, stream.progress и download.progress идут в эфемерный store; resync его очищает', async () => {
    const server = new FakeSyncServer();
    const env = makeEnv(server);
    await sync(env);
    env.engine.handleEvent({ album_id: 3, done: 1, stage: 'searching', total: 5, type: 'job.progress' });
    env.engine.handleEvent({
      bytes_done: 5,
      bytes_total: 50,
      down_speed_bps: 1,
      peers: 2,
      track_id: 9,
      type: 'stream.progress',
    });
    await env.engine.settled();
    expect(env.live.getState().albumProgress.get(3)).toEqual({ done: 1, stage: 'searching', total: 5 });
    expect(env.live.getState().streamProgress.get(9)).toMatchObject({ peers: 2 });
    env.engine.handleEvent({
      album_id: 4,
      bytes_done: 7,
      bytes_total: 70,
      down_bps: 3,
      peers: 1,
      type: 'download.progress',
    });
    await env.engine.settled();
    expect(env.live.getState().downloadProgress.get(4)).toEqual({
      bytes_done: 7,
      bytes_total: 70,
      down_bps: 3,
      peers: 1,
    });
    env.engine.handleEvent({ type: 'resync' });
    expect(env.live.getState().albumProgress.size).toBe(0);
    expect(env.live.getState().streamProgress.size).toBe(0);
    expect(env.live.getState().downloadProgress.size).toBe(0);
    await env.engine.settled();
  });
});

// Вкладки: общий лок и общий канал.
function makeBrowser() {
  const queue: { cb: () => Promise<unknown>; resolve: () => void }[] = [];
  let held = false;
  const run = (job: (typeof queue)[number]) => {
    held = true;
    void job.cb().finally(() => {
      held = false;
      const next = queue.shift();
      if (next) run(next);
    });
  };
  const locks: LockManagerLike = {
    request: (_name, options, cb) =>
      new Promise<void>(resolve => {
        const job = { cb, resolve };
        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            const i = queue.indexOf(job);
            if (i >= 0) queue.splice(i, 1);
            resolve();
          });
        }
        if (held) queue.push(job);
        else run(job);
      }),
  };
  const channels = new Set<ChannelLike>();
  const channel = (): ChannelLike => {
    const ch: ChannelLike = {
      close: () => void channels.delete(ch),
      onmessage: null,
      postMessage: message => {
        for (const other of channels) if (other !== ch) queueMicrotask(() => other.onmessage?.({ data: message }));
      },
    };
    channels.add(ch);
    return ch;
  };
  return { newTabs: () => createTabs({ channel, locks }) };
}

describe('несколько вкладок', () => {
  it('синхронизирует одна вкладка (лидер), данные видны в обеих; лидер ушёл — ведомая подхватывает', async () => {
    const server = new FakeSyncServer().load(makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 }));
    const browser = makeBrowser();
    const dbName = `tabs-${++n}`;
    const a = makeEnv(server, { dbName, tabs: browser.newTabs() });
    const b = makeEnv(server, { dbName, tabs: browser.newTabs() });

    await a.engine.start();
    await a.engine.settled();
    await b.engine.start();
    await b.engine.settled();
    expect(server.snapshotRequests).toBe(1);
    expect(server.changesRequests).toBe(0);
    // B получила данные снимка через reload из общей базы.
    await vi.waitFor(() => expect(ids(b)).toEqual([1, 2]));

    // Дельта лидера доходит до ведомой через BroadcastChannel.
    server.upsert('track', makeTrack({ album_id: 1, artist_id: 1, id: 30 }));
    a.engine.handleEvent({ type: 'sync.poke' });
    b.engine.handleEvent({ type: 'sync.poke' }); // ведомая сама не синхронизирует
    await a.engine.settled();
    await vi.waitFor(() => expect(ids(b)).toEqual([1, 2, 30]));
    expect(server.changesRequests).toBe(1);
    expect(b.engine.status.getState().state).toBe('live');

    // Лидер закрылся: блокировку получает B и делает дельту с актуальным курсором.
    a.engine.stop();
    server.upsert('track', makeTrack({ album_id: 1, artist_id: 1, id: 31 }));
    await vi.waitFor(() => expect(ids(b)).toEqual([1, 2, 30, 31]));
    expect(server.snapshotRequests).toBe(1);
  });
});

describe('tabs без Web Locks и BroadcastChannel', () => {
  it('вкладка сама себе лидер, сообщения никуда не уходят', () => {
    const tabs = createTabs({ channel: null, locks: null });
    const lead = vi.fn();
    tabs.lead(lead);
    tabs.post({ type: 'reload' });
    tabs.onMessage(() => undefined);
    tabs.close();
    expect(lead).toHaveBeenCalledOnce();
  });
});
