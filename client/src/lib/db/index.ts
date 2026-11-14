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
export const DB_VERSION = 2;

const ROW_STORES = ['artists', 'albums', 'tracks', 'playlists', 'playlist_tracks'] as const;
type RowStore = (typeof ROW_STORES)[number];

const STORE_OF: Record<Entity, RowStore> = {
  album: 'albums',
  artist: 'artists',
  playlist: 'playlists',
  playlist_track: 'playlist_tracks',
  track: 'tracks',
};

const FIELD_OF: Record<RowStore, keyof LibraryRows> = {
  albums: 'albums',
  artists: 'artists',
  playlist_tracks: 'playlistTracks',
  playlists: 'playlists',
  tracks: 'tracks',
};

/** Почему соединение закрыто: другая вкладка обновляет схему, либо наша попытка обновления заблокирована. */
export type DbClosedReason = 'versionchange' | 'blocked';

export interface Db {
  /** `false` — IndexedDB недоступна, данные живут только в памяти (проверять после `ready`). */
  readonly persistent: boolean;
  /** Резолвится, когда выбран способ хранения (IndexedDB или память). */
  readonly ready: Promise<void>;
  loadAll(): Promise<LibraryData>;
  /** Только служебные значения (дёшево, без чтения библиотеки). */
  loadMeta(): Promise<Meta>;
  /** Upsert + удаления + `meta` в одной транзакции: при ошибке не меняется ничего. */
  applyBatch(batch: Batch): Promise<void>;
  /** Очищает всё и записывает снимок (одной транзакцией). */
  replaceAll(data: LibraryData): Promise<void>;
  /** Частичное обновление трека (мгновенные события); нет трека — ничего не делает. */
  patchTrack(id: number, partial: Partial<Track>): Promise<void>;
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
        upgrade(db, oldVersion) {
          if (oldVersion < 1) {
            for (const store of ROW_STORES) db.createObjectStore(store, { keyPath: 'id' });
            db.createObjectStore('meta');
            db.createObjectStore('outbox', { autoIncrement: true });
          }
          // Версия 2 (шаг 46): офлайн-треки. Данные версии 1 остаются на месте.
          if (oldVersion < 2) {
            db.createObjectStore('offline_pins', { keyPath: 'key' });
            db.createObjectStore('offline_files', { keyPath: 'track_id' });
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
        for (const store of ROW_STORES) {
          for (const row of batch[FIELD_OF[store]] ?? []) writes.push(tx.objectStore(store).put(row));
        }
        for (const d of batch.deleted ?? []) {
          const store = STORE_OF[d.entity as Entity];
          if (store) writes.push(tx.objectStore(store).delete(d.id));
        }
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
      const db = await handle();
      if (!db) return memory.loadAll();
      const tx = db.transaction([...ROW_STORES, 'meta'], 'readonly');
      const [artists, albums, tracks, playlists, playlistTracks, metaKeys, metaValues] = await Promise.all([
        tx.objectStore('artists').getAll(),
        tx.objectStore('albums').getAll(),
        tx.objectStore('tracks').getAll(),
        tx.objectStore('playlists').getAll(),
        tx.objectStore('playlist_tracks').getAll(),
        tx.objectStore('meta').getAllKeys(),
        tx.objectStore('meta').getAll(),
      ]);
      const meta: Record<string, unknown> = {};
      metaKeys.forEach((k, i) => (meta[String(k)] = metaValues[i]));
      return { albums, artists, meta: meta as Meta, playlistTracks, playlists, tracks };
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

    async patchTrack(id, partial) {
      const db = await handle();
      if (!db) return memory.patchTrack(id, partial);
      const tx = db.transaction('tracks', 'readwrite');
      const current = (await tx.store.get(id)) as Track | undefined;
      if (current) await tx.store.put({ ...current, ...partial, id });
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
        for (const store of ROW_STORES) {
          for (const row of data[FIELD_OF[store]]) writes.push(tx.objectStore(store).put(row));
        }
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
      for (const store of ROW_STORES) {
        for (const row of (batch[FIELD_OF[store]] ?? []) as { id: number }[]) rows[store].set(row.id, row);
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
      for (const store of ROW_STORES) (out as Record<string, unknown>)[FIELD_OF[store]] = [...rows[store].values()];
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
    patchTrack(id: number, partial: Partial<Track>) {
      const current = rows.tracks.get(id) as Track | undefined;
      if (current) rows.tracks.set(id, { ...current, ...partial, id });
    },
    replaceAll(data: LibraryData) {
      wipe();
      this.applyBatch({ ...data, meta: data.meta });
    },
  };
}
