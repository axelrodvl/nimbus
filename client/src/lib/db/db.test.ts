import { describe, expect, it, vi } from 'vitest';
import { makeAlbum, makeArtist, makeLibrary, makeTrack } from '@/test/factories';
import { createDb } from './index';

let n = 0;
const name = () => `nimbus-test-${++n}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('IndexedDB', () => {
  it('loadAll возвращает записанное; пустая база — пустые списки', async () => {
    const db = createDb({ name: name() });
    const empty = await db.loadAll();
    expect(empty).toEqual({ albums: [], artists: [], meta: {}, playlistTracks: [], playlists: [], tracks: [] });
    expect(db.persistent).toBe(true);

    const rows = makeLibrary({ albumsPerArtist: 1, artists: 2, tracksPerAlbum: 2 });
    await db.applyBatch({ ...rows, meta: { cursor: 'c1', schema: 1, syncedAt: 5 } });
    const loaded = await db.loadAll();
    expect(loaded.tracks).toHaveLength(4);
    expect(loaded.artists.map(a => a.id).sort()).toEqual([1, 2]);
    expect(loaded.meta).toEqual({ cursor: 'c1', schema: 1, syncedAt: 5 });
    expect(await db.loadMeta()).toEqual(loaded.meta);
  });

  it('applyBatch: upsert, удаления и курсор — в одной транзакции', async () => {
    const db = createDb({ name: name() });
    const rows = makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 });
    await db.applyBatch({ ...rows, meta: { cursor: 'a' } });
    await db.applyBatch({
      deleted: [
        { entity: 'track', id: 1 },
        { entity: 'bogus', id: 99 },
      ],
      meta: { cursor: 'b' },
      tracks: [{ ...(rows.tracks[1] as (typeof rows.tracks)[0]), title: 'Renamed' }],
    });
    const loaded = await db.loadAll();
    expect(loaded.tracks.map(t => t.title)).toEqual(['Renamed']);
    expect(loaded.meta.cursor).toBe('b');
  });

  it('ошибка посередине пачки откатывает всё: ни строк, ни курсора', async () => {
    const db = createDb({ name: name() });
    await db.applyBatch({ artists: [makeArtist({ id: 1 })], meta: { cursor: 'old' } });
    const bad = { ...makeTrack({ id: 5 }), boom: () => 1 } as unknown as ReturnType<typeof makeTrack>;
    await expect(
      db.applyBatch({ artists: [makeArtist({ id: 2 })], meta: { cursor: 'new' }, tracks: [bad] }),
    ).rejects.toThrow();
    const loaded = await db.loadAll();
    expect(loaded.artists.map(a => a.id)).toEqual([1]);
    expect(loaded.tracks).toEqual([]);
    expect(loaded.meta.cursor).toBe('old');
  });

  it('повторное применение той же пачки не меняет данные (идемпотентность)', async () => {
    const db = createDb({ name: name() });
    const batch = { ...makeLibrary(), deleted: [{ entity: 'track', id: 2 }], meta: { cursor: 'x' } };
    await db.applyBatch(batch);
    const once = clone(await db.loadAll());
    await db.applyBatch(batch);
    expect(clone(await db.loadAll())).toEqual(once);
  });

  it('replaceAll заменяет всё, включая служебные значения', async () => {
    const db = createDb({ name: name() });
    await db.applyBatch({ ...makeLibrary(), meta: { cursor: 'old', syncedAt: 1 } });
    const fresh = makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 1 });
    await db.replaceAll({ ...fresh, meta: { cursor: 'new', schema: 1 } });
    const loaded = await db.loadAll();
    expect(loaded.tracks).toHaveLength(1);
    expect(loaded.meta).toEqual({ cursor: 'new', schema: 1 });
  });

  it('ошибка в replaceAll оставляет прежние данные', async () => {
    const db = createDb({ name: name() });
    await db.applyBatch({ ...makeLibrary({ artists: 1 }), meta: { cursor: 'old' } });
    const bad = { ...makeTrack({ id: 77 }), boom: () => 1 } as unknown as ReturnType<typeof makeTrack>;
    await expect(
      db.replaceAll({
        albums: [],
        artists: [],
        meta: { cursor: 'new' },
        playlistTracks: [],
        playlists: [],
        tracks: [bad],
      }),
    ).rejects.toThrow();
    const loaded = await db.loadAll();
    expect(loaded.artists.length).toBeGreaterThan(0);
    expect(loaded.meta.cursor).toBe('old');
  });

  it('patchTrack меняет трек и игнорирует отсутствующий', async () => {
    const db = createDb({ name: name() });
    await db.applyBatch({ tracks: [makeTrack({ id: 1, status: 'adding' })] });
    await db.patchTrack(1, { status: 'ready' });
    await db.patchTrack(404, { status: 'ready' });
    const loaded = await db.loadAll();
    expect(loaded.tracks).toHaveLength(1);
    expect(loaded.tracks[0]?.status).toBe('ready');
  });

  it('clear очищает библиотеку и курсор, но не outbox', async () => {
    const db = createDb({ name: name() });
    await db.applyBatch({ ...makeLibrary(), meta: { cursor: 'x' } });
    await db.outboxAdd({ at: 1, trackId: 3 });
    await db.clear();
    const loaded = await db.loadAll();
    expect(loaded.tracks).toEqual([]);
    expect(loaded.meta).toEqual({});
    expect(await db.outboxAll()).toHaveLength(1);
  });

  it('outbox хранит порядок и удаляет по id', async () => {
    const db = createDb({ name: name() });
    await db.outboxAdd({ at: 1, trackId: 10 });
    await db.outboxAdd({ at: 2, trackId: 11 });
    const all = await db.outboxAll();
    expect(all.map(o => o.trackId)).toEqual([10, 11]);
    await db.outboxRemove(all[0]?.id ?? -1);
    expect((await db.outboxAll()).map(o => o.trackId)).toEqual([11]);
  });

  it('данные переживают переоткрытие базы', async () => {
    const dbName = name();
    const a = createDb({ name: dbName });
    await a.applyBatch({ albums: [makeAlbum({ id: 3 })] });
    a.close();
    const b = createDb({ name: dbName });
    expect((await b.loadAll()).albums.map(x => x.id)).toEqual([3]);
  });

  it('другая вкладка обновляет схему: соединение закрывается и сообщает наверх', async () => {
    const dbName = name();
    const onClosed = vi.fn();
    const db = createDb({ name: dbName, onClosed });
    await db.loadAll();
    // Вторая «вкладка» открывает базу с более новой версией.
    const upgraded = indexedDB.open(dbName, 2);
    await new Promise<void>((resolve, reject) => {
      upgraded.onsuccess = () => resolve();
      upgraded.onerror = () => reject(upgraded.error);
    });
    upgraded.result.close();
    expect(onClosed).toHaveBeenCalledWith('versionchange');
    await expect(db.loadAll()).rejects.toThrow(/closed/);
  });
});

describe('IndexedDB недоступна', () => {
  it('работает только в памяти с флагом persistent = false', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const db = createDb({ name: name() });
    await db.ready;
    expect(db.persistent).toBe(false);

    const rows = makeLibrary({ albumsPerArtist: 1, artists: 1, tracksPerAlbum: 2 });
    await db.applyBatch({ ...rows, meta: { cursor: 'm' } });
    await db.patchTrack(1, { status: 'adding' });
    await db.patchTrack(404, { status: 'adding' });
    await db.outboxAdd({ at: 1, trackId: 1 });
    await db.outboxAdd({ at: 2, trackId: 2 });
    await db.outboxRemove(1);

    const loaded = await db.loadAll();
    expect(loaded.tracks.find(t => t.id === 1)?.status).toBe('adding');
    expect(loaded.meta.cursor).toBe('m');
    expect(await db.loadMeta()).toEqual({ cursor: 'm' });
    expect((await db.outboxAll()).map(o => o.trackId)).toEqual([2]);

    await db.applyBatch({
      deleted: [
        { entity: 'track', id: 2 },
        { entity: 'x', id: 1 },
      ],
    });
    expect((await db.loadAll()).tracks.map(t => t.id)).toEqual([1]);

    await db.replaceAll({
      ...makeLibrary({ artists: 1, albumsPerArtist: 1, tracksPerAlbum: 1 }),
      meta: { cursor: 'r' },
    });
    expect((await db.loadAll()).meta.cursor).toBe('r');
    await db.clear();
    expect((await db.loadAll()).tracks).toEqual([]);
    expect(await db.outboxAll()).toHaveLength(1);
  });
});
