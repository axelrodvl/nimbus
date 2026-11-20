import { describe, expect, it, vi } from 'vitest';
import { makeAlbum, makeArtist, makeLibrary, makeTrack } from '@/test/factories';
import { openDB } from 'idb';
import { createDb, type OfflineFile } from './index';

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

  it('patchTracks применяет пачку одной транзакцией и пропускает отсутствующие', async () => {
    const db = createDb({ name: name() });
    await db.applyBatch({ tracks: [makeTrack({ id: 1, status: 'adding' }), makeTrack({ id: 2, status: 'adding' })] });
    await db.patchTracks(
      new Map([
        [1, { status: 'ready' as const }],
        [2, { status: 'found' as const }],
        [404, { status: 'ready' as const }],
      ]),
    );
    const loaded = (await db.loadAll()).tracks.sort((a, b) => a.id - b.id);
    expect(loaded.map(t => t.status)).toEqual(['ready', 'found']);
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

  it('миграция 1 → 2: библиотека и курсор сохраняются, появляются офлайн-хранилища', async () => {
    const dbName = name();
    // База версии 1, как её создавали шаги 37–45.
    const v1 = await openDB(dbName, 1, {
      upgrade(db) {
        for (const store of ['artists', 'albums', 'tracks', 'playlists', 'playlist_tracks']) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
        db.createObjectStore('meta');
        db.createObjectStore('outbox', { autoIncrement: true });
      },
    });
    await v1.put('tracks', makeTrack({ id: 7 }));
    await v1.put('meta', 'cursor-1', 'cursor');
    await v1.add('outbox', { at: 1, trackId: 7 });
    v1.close();

    const db = createDb({ name: dbName });
    const loaded = await db.loadAll();
    expect(loaded.tracks.map(t => t.id)).toEqual([7]);
    expect(loaded.meta.cursor).toBe('cursor-1');
    expect(await db.outboxAll()).toHaveLength(1);
    expect(await db.offlineLoad()).toEqual({ files: [], pins: [] });
  });

  it('миграция 2 → 3: треки версий 1–2 переезжают в пачки, старого хранилища нет', async () => {
    const dbName = name();
    const v2 = await openDB(dbName, 2, {
      upgrade(db) {
        for (const store of ['artists', 'albums', 'tracks', 'playlists', 'playlist_tracks']) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
        db.createObjectStore('meta');
        db.createObjectStore('outbox', { autoIncrement: true });
        db.createObjectStore('offline_pins', { keyPath: 'key' });
        db.createObjectStore('offline_files', { keyPath: 'track_id' });
      },
    });
    for (const id of [3, 1999, 2000, 4500]) await v2.put('tracks', makeTrack({ id }));
    await v2.put('meta', 'c', 'cursor');
    v2.close();
    const db = createDb({ name: dbName });
    expect((await db.loadTracks()).map(t => t.id)).toEqual([3, 1999, 2000, 4500]);
    expect((await db.loadMeta()).cursor).toBe('c');
    db.close();
    const check = await openDB(dbName);
    expect([...check.objectStoreNames]).not.toContain('tracks');
    expect(await check.count('track_chunks')).toBe(3);
    check.close();
  });

  it('миграция 2 → 3 не удалась: обновление откатывается, база уходит в память', async () => {
    const dbName = name();
    const v2 = await openDB(dbName, 2, {
      upgrade(db) {
        for (const store of ['artists', 'albums', 'playlists', 'playlist_tracks']) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
        db.createObjectStore('tracks', { keyPath: 'id' }); // без остальных хранилищ — читать нечего, но не падаем
        db.createObjectStore('meta');
        db.createObjectStore('outbox', { autoIncrement: true });
        db.createObjectStore('offline_pins', { keyPath: 'key' });
        db.createObjectStore('offline_files', { keyPath: 'track_id' });
      },
    });
    await v2.put('tracks', { id: 1 }); // строка без нужных полей — перенос идёт по id и проходит
    v2.close();
    // Сбой чтения старых треков: хранилище `tracks` недоступно в обновлении.
    const real = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'tracks') throw new Error('boom');
      return real.apply(this, args as []);
    });
    const db = createDb({ name: dbName });
    await db.ready;
    expect(db.persistent).toBe(false);
    vi.restoreAllMocks();
  });

  it('треки пачками по диапазону id: loadCore без треков; upsert/патч/удаление правят нужную пачку', async () => {
    const db = createDb({ name: name() });
    const rows = [1, 2, 2001, 2002, 6000].map(id => makeTrack({ id, status: 'adding' }));
    await db.applyBatch({ artists: [makeArtist({ id: 1 })], meta: { cursor: 'a' }, tracks: rows });
    const core = await db.loadCore();
    expect(core).not.toHaveProperty('tracks');
    expect(core.artists).toHaveLength(1);
    expect(core.meta.cursor).toBe('a');
    expect((await db.loadTracks()).map(t => t.id)).toEqual([1, 2, 2001, 2002, 6000]);

    await db.applyBatch({
      deleted: [
        { entity: 'track', id: 6000 }, // последняя строка пачки — пачка исчезает
        { entity: 'track', id: 2 },
      ],
      tracks: [makeTrack({ id: 2001, status: 'ready', title: 'New' }), makeTrack({ id: 4000 })],
    });
    await db.patchTracks(
      new Map([
        [1, { status: 'ready' }],
        [777, { status: 'ready' }], // нет такого трека — пропуск
      ]),
    );
    const loaded = await db.loadTracks();
    expect(loaded.map(t => t.id).sort((a, b) => a - b)).toEqual([1, 2001, 2002, 4000]);
    expect(loaded.find(t => t.id === 1)?.status).toBe('ready');
    expect(loaded.find(t => t.id === 2001)?.title).toBe('New');
    await db.replaceAll({ ...(await db.loadAll()), tracks: [makeTrack({ id: 9 })] });
    expect((await db.loadTracks()).map(t => t.id)).toEqual([9]);
  });

  it('офлайн: закрепления и файлы пишутся, читаются, удаляются; clear библиотеки их не трогает', async () => {
    const db = createDb({ name: name() });
    const file: OfflineFile = {
      attempts: 0,
      bytes_done: 10,
      bytes_total: 10,
      completed_at: 1,
      error: null,
      etag: '"x"',
      mime: 'audio/flac',
      next_attempt_at: null,
      resumable: true,
      state: 'done',
      track_id: 5,
    };
    await db.offlinePinPut({ created_at: 1, id: 3, key: 'album:3', kind: 'album' });
    await db.offlinePinPut({ created_at: 2, id: 4, key: 'track:4', kind: 'track' });
    await db.offlineFilePut(file);
    await db.offlineFilePut({ ...file, bytes_done: 20 });
    await db.clear();
    const loaded = await db.offlineLoad();
    expect(loaded.pins.map(p => p.key).sort()).toEqual(['album:3', 'track:4']);
    expect(loaded.files).toEqual([{ ...file, bytes_done: 20 }]);
    await db.offlinePinDelete('album:3');
    await db.offlineFileDelete(5);
    expect((await db.offlineLoad()).pins.map(p => p.key)).toEqual(['track:4']);
    expect((await db.offlineLoad()).files).toEqual([]);
    await db.offlineClear();
    expect(await db.offlineLoad()).toEqual({ files: [], pins: [] });
  });

  it('другая вкладка обновляет схему: соединение закрывается и сообщает наверх', async () => {
    const dbName = name();
    const onClosed = vi.fn();
    const db = createDb({ name: dbName, onClosed });
    await db.loadAll();
    // Вторая «вкладка» открывает базу с более новой версией.
    const upgraded = indexedDB.open(dbName, 99);
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
    expect((await db.loadTracks()).map(t => t.id)).toEqual([1, 2]);
    expect(await db.loadCore()).not.toHaveProperty('tracks');
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

  it('офлайн-записи в памяти', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const db = createDb({ name: name() });
    const file = { track_id: 1 } as OfflineFile;
    await db.offlinePinPut({ created_at: 1, id: 1, key: 'track:1', kind: 'track' });
    await db.offlinePinPut({ created_at: 1, id: 2, key: 'track:2', kind: 'track' });
    await db.offlinePinDelete('track:2');
    await db.offlineFilePut(file);
    await db.offlineFilePut({ track_id: 2 } as OfflineFile);
    await db.offlineFileDelete(2);
    expect(await db.offlineLoad()).toEqual({
      files: [file],
      pins: [{ created_at: 1, id: 1, key: 'track:1', kind: 'track' }],
    });
    await db.offlineClear();
    expect(await db.offlineLoad()).toEqual({ files: [], pins: [] });
  });
});
