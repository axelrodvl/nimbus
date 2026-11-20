import { openDB, type IDBPDatabase } from 'idb';
import {
  emptyRows,
  type Batch,
  type Entity,
  type LibraryData,
  type LibraryRows,
  type Meta,
  type OfflineFile,
  type OfflinePin,
  type OutboxItem,
  type Track,
} from './types';

export * from './types';

export const DB_NAME = 'nimbus';
export const DB_VERSION = 3;

/**
 * Таблицы с обычными строками (запись на ключ). Треки хранятся иначе — пачками (`track_chunks`): замер на 60 000
 * строк в Chromium — чтение «строка на ключ» 1434 мс (×4 CPU 1740 мс), пачками по 2000 — 88 мс (374 мс): почти всё
 * время `getAll` уходит на накладные расходы каждой записи, а не на разбор самих объектов (ревью F10).
 */
const PLAIN_STORES = ['artists', 'albums', 'playlists', 'playlist_tracks'] as const;
type PlainStore = (typeof PLAIN_STORES)[number];
const ROW_STORES = [...PLAIN_STORES, 'track_chunks'] as const;
type RowStore = PlainStore | 'tracks';

/** Размер диапазона id треков в одной записи: точечная запись — чтение-изменение-запись одной пачки. */
export const TRACK_CHUNK = 2000;
const chunkOf = (id: number) => Math.floor(id / TRACK_CHUNK);
type TrackChunk = { id: number; rows: Track[] };

const chunkRows = (tracks: readonly Track[]): TrackChunk[] => {
  const byChunk = new Map<number, Track[]>();
  for (const t of tracks) {
    const rows = byChunk.get(chunkOf(t.id));
    if (rows) rows.push(t);
    else byChunk.set(chunkOf(t.id), [t]);
  }
  return [...byChunk].map(([id, rows]) => ({ id, rows }));
};

/** Применяет изменения треков к пачкам внутри открытой транзакции (прочитать пачку → изменить → записать). */
async function writeTracks(
  store: { get(k: number): Promise<unknown>; put(v: unknown): Promise<unknown>; delete(k: number): Promise<unknown> },
  upserts: readonly Track[],
  deletes: readonly number[],
  patches?: ReadonlyMap<number, Partial<Track>>,
) {
  const touched = new Set<number>();
  for (const t of upserts) touched.add(chunkOf(t.id));
  for (const id of deletes) touched.add(chunkOf(id));
  for (const id of patches?.keys() ?? []) touched.add(chunkOf(id));
  const up = new Map<number, Track[]>();
  for (const t of upserts) up.set(chunkOf(t.id), [...(up.get(chunkOf(t.id)) ?? []), t]);
  const del = new Map<number, number[]>();
  for (const id of deletes) del.set(chunkOf(id), [...(del.get(chunkOf(id)) ?? []), id]);
  const pat = new Map<number, [number, Partial<Track>][]>();
  for (const e of patches ?? []) pat.set(chunkOf(e[0]), [...(pat.get(chunkOf(e[0])) ?? []), e]);
  for (const chunk of touched) {
    const current = ((await store.get(chunk)) as TrackChunk | undefined)?.rows ?? [];
    const rows = new Map(current.map(t => [t.id, t]));
    for (const t of up.get(chunk) ?? []) rows.set(t.id, t);
    for (const [id, partial] of pat.get(chunk) ?? []) {
      const old = rows.get(id);
      if (old) rows.set(id, { ...old, ...partial, id });
    }
    for (const id of del.get(chunk) ?? []) rows.delete(id);
    if (rows.size === 0) await store.delete(chunk);
    else await store.put({ id: chunk, rows: [...rows.values()] });
  }
}

const STORE_OF: Record<Entity, RowStore> = {
  album: 'albums',
  artist: 'artists',
  playlist: 'playlists',
  playlist_track: 'playlist_tracks',
  track: 'tracks',
};

const FIELD_OF: Record<PlainStore, keyof LibraryRows> = {
  albums: 'albums',
  artists: 'artists',
  playlist_tracks: 'playlistTracks',
  playlists: 'playlists',
};

/** Почему соединение закрыто: другая вкладка обновляет схему, либо наша попытка обновления заблокирована. */
export type DbClosedReason = 'versionchange' | 'blocked';

export interface Db {
  /** `false` — IndexedDB недоступна, данные живут только в памяти (проверять после `ready`). */
  readonly persistent: boolean;
  /** Резолвится, когда выбран способ хранения (IndexedDB или память). */
  readonly ready: Promise<void>;
  loadAll(): Promise<LibraryData>;
  /** Фаза 1 гидрации: всё, кроме треков (их на порядок больше), и служебные значения. */
  loadCore(): Promise<Omit<LibraryData, 'tracks'>>;
  /** Фаза 2 гидрации: все треки (пачками, по возрастанию id). */
  loadTracks(): Promise<Track[]>;
  /** Только служебные значения (дёшево, без чтения библиотеки). */
  loadMeta(): Promise<Meta>;
  /** Upsert + удаления + `meta` в одной транзакции: при ошибке не меняется ничего. */
  applyBatch(batch: Batch): Promise<void>;
  /** Очищает всё и записывает снимок (одной транзакцией). */
  replaceAll(data: LibraryData): Promise<void>;
  /** Частичное обновление трека (мгновенные события); нет трека — ничего не делает. */
  patchTrack(id: number, partial: Partial<Track>): Promise<void>;
  /** Пачка патчей треков одной транзакцией; отсутствующие id пропускаются. */
  patchTracks(patches: ReadonlyMap<number, Partial<Track>>): Promise<void>;
  clear(): Promise<void>;
  outboxAdd(item: Omit<OutboxItem, 'id'>): Promise<void>;
  outboxAll(): Promise<OutboxItem[]>;
  outboxRemove(id: number): Promise<void>;
  /** Закрепления и файлы офлайн-хранилища (шаг 46); не стираются `clear()` — их чистит `offline.clear()`. */
  offlineLoad(): Promise<{ pins: OfflinePin[]; files: OfflineFile[] }>;
  offlinePinPut(pin: OfflinePin): Promise<void>;
  offlinePinDelete(key: string): Promise<void>;
  offlineFilePut(file: OfflineFile): Promise<void>;
  offlineFileDelete(trackId: number): Promise<void>;
  offlineClear(): Promise<void>;
  close(): void;
}

export type DbOptions = {
  name?: string;
  /** Вызывается, когда соединение закрыто (после этого база непригодна: оболочка перезагружает страницу). */
  onClosed?: (reason: DbClosedReason) => void;
};

function sanitizeMeta(meta: Partial<Meta>): [string, unknown][] {
  return Object.entries(meta).filter(([, v]) => v !== undefined);
}

/** База `nimbus`. Открывается лениво при первом обращении; если IndexedDB недоступна — работает в памяти. */
export function createDb(options: DbOptions = {}): Db {
  const name = options.name ?? DB_NAME;
  let idb: IDBPDatabase | null = null;
  let closed = false;
  let persistent = false;
  const memory = createMemory();

  const ready = (async () => {
    try {
      idb = await openDB(name, DB_VERSION, {
        blocked() {
          options.onClosed?.('blocked');
        },
        blocking() {
          // Другая вкладка хочет обновить схему: освобождаем базу.
          closed = true;
          idb?.close();
          options.onClosed?.('versionchange');
        },
        terminated() {
          closed = true;
          options.onClosed?.('versionchange');
        },
        upgrade(db, oldVersion, _newVersion, transaction) {
          if (oldVersion < 1) {
            for (const store of PLAIN_STORES) db.createObjectStore(store, { keyPath: 'id' });
            db.createObjectStore('meta');
            db.createObjectStore('outbox', { autoIncrement: true });
          }
          // Версия 2 (шаг 46): офлайн-треки. Данные версии 1 остаются на месте.
          if (oldVersion < 2) {
            db.createObjectStore('offline_pins', { keyPath: 'key' });
            db.createObjectStore('offline_files', { keyPath: 'track_id' });
          }
          // Версия 3 (ревью F10): треки пачками. Строки версий 1–2 переносятся в пачки внутри этого же обновления.
          if (oldVersion < 3) {
            db.createObjectStore('track_chunks', { keyPath: 'id' });
            if (oldVersion >= 1) {
              void (async () => {
                try {
                  const rows = (await transaction.objectStore('tracks').getAll()) as Track[];
                  const chunks = transaction.objectStore('track_chunks');
                  for (const chunk of chunkRows(rows)) void chunks.put(chunk);
                  db.deleteObjectStore('tracks');
                } catch {
                  // Откат всего обновления: база не откроется, приложение продолжит в памяти (`persistent = false`).
                  transaction.done.catch(() => undefined);
                  transaction.abort();
                }
              })();
            }
          }
        },
      });
      persistent = true;
    } catch {
      // Приватный режим / отказ пользователя / нет IndexedDB: работаем только в памяти.
      idb = null;
      persistent = false;
    }
  })();

  async function handle(): Promise<IDBPDatabase | null> {
    await ready;
    if (closed) throw new Error('db closed');
    return idb;
  }

  return {
    async applyBatch(batch) {
      const db = await handle();
      if (!db) return memory.applyBatch(batch);
      const tx = db.transaction([...ROW_STORES, 'meta'], 'readwrite');
      const writes: Promise<unknown>[] = [];
      try {
        for (const store of PLAIN_STORES) {
          for (const row of batch[FIELD_OF[store]] ?? []) writes.push(tx.objectStore(store).put(row));
        }
        const deleted = batch.deleted ?? [];
        for (const d of deleted) {
          const store = STORE_OF[d.entity as Entity];
          if (store && store !== 'tracks') writes.push(tx.objectStore(store).delete(d.id));
        }
        writes.push(
          writeTracks(
            tx.objectStore('track_chunks'),
            batch.tracks ?? [],
            deleted.filter(d => d.entity === 'track').map(d => d.id),
          ),
        );
        for (const [k, v] of sanitizeMeta(batch.meta ?? {})) writes.push(tx.objectStore('meta').put(v, k));
        await Promise.all(writes);
        await tx.done;
      } catch (e) {
        abort(tx, writes);
        throw e;
      }
    },

    clear: async () => {
      const db = await handle();
      if (!db) return memory.clear();
      const tx = db.transaction([...ROW_STORES, 'meta'], 'readwrite');
      await Promise.all([...ROW_STORES, 'meta' as const].map(s => tx.objectStore(s).clear()));
      await tx.done;
    },

    close() {
      closed = true;
      idb?.close();
    },

    async loadAll() {
      const [core, tracks] = await Promise.all([this.loadCore(), this.loadTracks()]);
      return { ...core, tracks };
    },

    async loadCore() {
      const db = await handle();
      if (!db) {
        const { tracks: _tracks, ...core } = memory.loadAll();
        return core;
      }
      const tx = db.transaction([...PLAIN_STORES, 'meta'], 'readonly');
      const [artists, albums, playlists, playlistTracks, metaKeys, metaValues] = await Promise.all([
        tx.objectStore('artists').getAll(),
        tx.objectStore('albums').getAll(),
        tx.objectStore('playlists').getAll(),
        tx.objectStore('playlist_tracks').getAll(),
        tx.objectStore('meta').getAllKeys(),
        tx.objectStore('meta').getAll(),
      ]);
      const meta: Record<string, unknown> = {};
      metaKeys.forEach((k, i) => (meta[String(k)] = metaValues[i]));
      return { albums, artists, meta: meta as Meta, playlistTracks, playlists };
    },

    async loadTracks() {
      const db = await handle();
      if (!db) return memory.loadAll().tracks;
      const chunks = (await db.getAll('track_chunks')) as TrackChunk[];
      return chunks.flatMap(c => c.rows);
    },

    async loadMeta() {
      const db = await handle();
      if (!db) return memory.loadAll().meta;
      const tx = db.transaction('meta', 'readonly');
      const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll()]);
      const meta: Record<string, unknown> = {};
      keys.forEach((k, i) => (meta[String(k)] = values[i]));
      return meta as Meta;
    },

    async outboxAdd(item) {
      const db = await handle();
      if (!db) return memory.outboxAdd(item);
      await db.add('outbox', item);
    },

    async outboxAll() {
      const db = await handle();
      if (!db) return memory.outboxAll();
      const tx = db.transaction('outbox', 'readonly');
      const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll()]);
      return values.map((v: Omit<OutboxItem, 'id'>, i) => ({ ...v, id: Number(keys[i]) }));
    },

    async outboxRemove(id) {
      const db = await handle();
      if (!db) return memory.outboxRemove(id);
      await db.delete('outbox', id);
    },

    async offlineClear() {
      const db = await handle();
      if (!db) return memory.offlineClear();
      const tx = db.transaction(['offline_pins', 'offline_files'], 'readwrite');
      await Promise.all([tx.objectStore('offline_pins').clear(), tx.objectStore('offline_files').clear()]);
      await tx.done;
    },

    async offlineFileDelete(trackId) {
      const db = await handle();
      if (!db) return memory.offlineFileDelete(trackId);
      await db.delete('offline_files', trackId);
    },

    async offlineFilePut(file) {
      const db = await handle();
      if (!db) return memory.offlineFilePut(file);
      await db.put('offline_files', file);
    },

    async offlineLoad() {
      const db = await handle();
      if (!db) return memory.offlineLoad();
      const tx = db.transaction(['offline_pins', 'offline_files'], 'readonly');
      const [pins, files] = await Promise.all([
        tx.objectStore('offline_pins').getAll(),
        tx.objectStore('offline_files').getAll(),
      ]);
      return { files: files as OfflineFile[], pins: pins as OfflinePin[] };
    },

    async offlinePinDelete(key) {
      const db = await handle();
      if (!db) return memory.offlinePinDelete(key);
      await db.delete('offline_pins', key);
    },

    async offlinePinPut(pin) {
      const db = await handle();
      if (!db) return memory.offlinePinPut(pin);
      await db.put('offline_pins', pin);
    },

    patchTrack(id, partial) {
      return this.patchTracks(new Map([[id, partial]]));
    },

    async patchTracks(patches) {
      const db = await handle();
      if (!db) return memory.patchTracks(patches);
      const tx = db.transaction('track_chunks', 'readwrite');
      await writeTracks(tx.store, [], [], patches);
      await tx.done;
    },

    get persistent() {
      return persistent;
    },

    ready,

    async replaceAll(data) {
      const db = await handle();
      if (!db) return memory.replaceAll(data);
      const tx = db.transaction([...ROW_STORES, 'meta'], 'readwrite');
      const writes: Promise<unknown>[] = [];
      try {
        writes.push(...[...ROW_STORES, 'meta' as const].map(s => tx.objectStore(s).clear()));
        for (const store of PLAIN_STORES) {
          for (const row of data[FIELD_OF[store]]) writes.push(tx.objectStore(store).put(row));
        }
        for (const chunk of chunkRows(data.tracks)) writes.push(tx.objectStore('track_chunks').put(chunk));
        for (const [k, v] of sanitizeMeta(data.meta)) writes.push(tx.objectStore('meta').put(v, k));
        await Promise.all(writes);
        await tx.done;
      } catch (e) {
        abort(tx, writes);
        throw e;
      }
    },
  };
}

function abort(tx: { abort(): void; done: Promise<unknown> }, writes: Promise<unknown>[]) {
  // Прерванная транзакция отклоняет и `done`, и все ещё не завершённые запросы: ошибка уже передана вызывающему.
  tx.done.catch(() => undefined);
  writes.forEach(w => w.catch(() => undefined));
  try {
    tx.abort();
  } catch {
    // Транзакция уже завершена или прервана — откат состоялся.
  }
}

/** Запасное хранилище в памяти (та же семантика, что у IndexedDB, но без персистентности). */
function createMemory() {
  const rows: Record<RowStore, Map<number, unknown>> = {
    albums: new Map(),
    artists: new Map(),
    playlist_tracks: new Map(),
    playlists: new Map(),
    tracks: new Map(),
  };
  let meta: Meta = {};
  let outbox: OutboxItem[] = []; // не очищается `clear()`, как и в IndexedDB
  const pins = new Map<string, OfflinePin>();
  const files = new Map<number, OfflineFile>();
  let seq = 0;

  const wipe = () => {
    for (const m of Object.values(rows)) m.clear();
    meta = {};
  };

  return {
    applyBatch(batch: Batch) {
      for (const store of [...PLAIN_STORES, 'tracks'] as const) {
        const field = store === 'tracks' ? 'tracks' : FIELD_OF[store];
        for (const row of (batch[field] ?? []) as { id: number }[]) rows[store].set(row.id, row);
      }
      for (const d of batch.deleted ?? []) {
        const store = STORE_OF[d.entity as Entity];
        if (store) rows[store].delete(d.id);
      }
      meta = { ...meta, ...Object.fromEntries(sanitizeMeta(batch.meta ?? {})) };
    },
    clear() {
      wipe();
    },
    loadAll(): LibraryData {
      const out: Partial<LibraryRows> = emptyRows();
      for (const store of [...PLAIN_STORES, 'tracks'] as const) {
        (out as Record<string, unknown>)[store === 'tracks' ? 'tracks' : FIELD_OF[store]] = [...rows[store].values()];
      }
      return { ...(out as LibraryRows), meta: { ...meta } };
    },
    offlineClear() {
      pins.clear();
      files.clear();
    },
    offlineFileDelete(trackId: number) {
      files.delete(trackId);
    },
    offlineFilePut(file: OfflineFile) {
      files.set(file.track_id, file);
    },
    offlineLoad: () => ({ files: [...files.values()], pins: [...pins.values()] }),
    offlinePinDelete(key: string) {
      pins.delete(key);
    },
    offlinePinPut(pin: OfflinePin) {
      pins.set(pin.key, pin);
    },
    outboxAdd(item: Omit<OutboxItem, 'id'>) {
      outbox.push({ ...item, id: ++seq });
    },
    outboxAll: () => [...outbox],
    outboxRemove(id: number) {
      outbox = outbox.filter(o => o.id !== id);
    },
    patchTracks(patches: ReadonlyMap<number, Partial<Track>>) {
      for (const [id, partial] of patches) {
        const current = rows.tracks.get(id) as Track | undefined;
        if (current) rows.tracks.set(id, { ...current, ...partial, id });
      }
    },
    replaceAll(data: LibraryData) {
      wipe();
      this.applyBatch({ ...data, meta: data.meta });
    },
  };
}
