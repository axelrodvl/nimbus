import { ApiError } from '@/lib/api/errors';
import { lifecycle } from '@/lib/platform/lifecycle';
import type { Db } from '@/lib/db';
import type { Batch, LibraryRows } from '@/lib/db/types';
import type { LibraryStore, TrackPatch } from '@/lib/store/library';
import type { AlbumProgress, DownloadProgress, LiveStore, StreamProgress } from '@/lib/store/live';
import type { ChangesResponse, SyncApi } from '@/lib/api/sync';
import { createSyncStatusStore, type SyncState, type SyncStatusStore } from './status';
import type { Tabs, TabMessage } from './tabs';

/** Версия формата синхронизации, с которой работает клиент (`SYNC_SCHEMA` бэкенда). */
export const SYNC_SCHEMA = 1;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const SAFETY_POLL_MS = 5 * 60_000;
/** Окно объединения live-событий (`track.status`, прогресс): одна пачка на окно. */
export const LIVE_FLUSH_MS = 50;

/** События WebSocket (`/api/ws`), которые понимает движок; остальные игнорируются. */
export type EngineEvent =
  | { type: 'sync.poke' }
  | { type: 'resync' }
  | {
      type: 'track.status';
      track_id: number;
      album_id: number;
      status: 'adding' | 'found' | 'not_found' | 'ready';
      reason: string | null;
    }
  | { type: 'job.progress'; album_id: number; stage: 'searching' | 'verifying'; done: number; total: number }
  | {
      type: 'download.progress';
      album_id: number;
      bytes_done: number;
      bytes_total: number;
      down_bps: number;
      peers: number;
    }
  | {
      type: 'stream.progress';
      track_id: number;
      bytes_done: number;
      bytes_total: number;
      peers: number;
      down_speed_bps: number;
    }
  | { type: string };

export type EngineDeps = {
  api: SyncApi;
  db: Db;
  store: LibraryStore;
  live: LiveStore;
  tabs: Tabs;
  status?: SyncStatusStore;
  /** 401: вход потерян — движок остановлен, оболочка показывает экран входа. */
  onUnauthorized?: () => void;
  random?: () => number;
  now?: () => number;
};

type SnapshotLine =
  | { type: 'begin'; cursor: string; schema: number }
  | { type: 'artist' | 'album' | 'track' | 'playlist' | 'playlist_track'; row: unknown }
  | { type: 'end'; counts: Record<string, number> };

const BUCKET = {
  album: 'albums',
  artist: 'artists',
  playlist: 'playlists',
  playlist_track: 'playlistTracks',
  track: 'tracks',
} as const;

const COUNT_KEY: Record<keyof LibraryRows, string> = {
  albums: 'albums',
  artists: 'artists',
  playlistTracks: 'playlist_tracks',
  playlists: 'playlists',
  tracks: 'tracks',
};

const isNetwork = (e: unknown) => e instanceof ApiError && e.status === 0;

export function createSyncEngine(deps: EngineDeps) {
  const { api, db, live, store, tabs } = deps;
  const status = deps.status ?? createSyncStatusStore();
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;

  let cursor: string | undefined;
  let running: Promise<void> | null = null;
  let again = false;
  let forceSnapshot = false;
  let stopped = true;
  let leader = false;
  let starting: Promise<void> = Promise.resolve();
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let abort: AbortController | null = null;
  const detach: (() => void)[] = [];

  // Буфер live-событий: последнее событие по ключу побеждает, применяется пачкой раз в LIVE_FLUSH_MS.
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let patches = new Map<number, TrackPatch>();
  let patchedAlbums = new Set<number>();
  let albumProgress = new Map<number, AlbumProgress>();
  let downloadProgress = new Map<number, DownloadProgress>();
  let streamProgress = new Map<number, StreamProgress>();
  let dbWrite: Promise<void> = Promise.resolve();

  function dropBuffer() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    patches = new Map();
    patchedAlbums = new Set();
    albumProgress = new Map();
    downloadProgress = new Map();
    streamProgress = new Map();
  }

  /** Применяет накопленные события одним обновлением store, одной транзакцией и одним `set` в live. */
  function flush(): Promise<void> {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    const toPatch = patches;
    const albums = patchedAlbums;
    const batch = { album: albumProgress, download: downloadProgress, stream: streamProgress };
    patches = new Map();
    patchedAlbums = new Set();
    albumProgress = new Map();
    downloadProgress = new Map();
    streamProgress = new Map();
    if (toPatch.size) {
      store.getState().patchTracks(toPatch);
      dbWrite = db.patchTracks(toPatch).catch(() => undefined); // Дельта всё равно догонит.
    }
    // Альбом без треков `adding` больше не «ищется».
    const { tracks, tracksByAlbum } = store.getState();
    const dropAlbums = [...albums].filter(
      id => ![...(tracksByAlbum.get(id) ?? [])].some(t => tracks.get(t)?.status === 'adding'),
    );
    live.getState().applyProgress({ ...batch, dropAlbums });
    return dbWrite;
  }

  const schedule = () => {
    flushTimer ??= setTimeout(() => void flush(), LIVE_FLUSH_MS);
  };

  const setState = (state: SyncState, extra: Partial<ReturnType<typeof status.getState>> = {}) =>
    status.setState({ state, ...extra });

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    clearRetry();
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** failures);
    failures += 1;
    // Джиттер ±20 %: клиенты не должны ломиться на сервер синхронно.
    const delay = base * (0.8 + random() * 0.4);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      requestSync('retry');
    }, delay);
  }

  function fail(error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err instanceof ApiError && err.status === 401) {
      stop();
      setState('error', { error: err, progress: null });
      deps.onUnauthorized?.();
      return;
    }
    const offline = isNetwork(err) || globalThis.navigator?.onLine === false;
    setState(offline ? 'offline' : 'error', { error: err, progress: null });
    if (!stopped) scheduleRetry();
  }

  async function applyChanges(res: ChangesResponse) {
    const batch: Batch = {
      albums: res.albums,
      artists: res.artists,
      deleted: res.deleted,
      meta: { cursor: res.cursor, schema: SYNC_SCHEMA, syncedAt: now() },
      playlistTracks: res.playlist_tracks,
      playlists: res.playlists,
      tracks: res.tracks,
    };
    // Отложенные патчи не должны перезаписать более свежую строку из дельты.
    await flush();
    // Сначала диск, потом память: при сбое записи store не уходит вперёд базы.
    await db.applyBatch(batch);
    store.getState().applyBatch(batch);
    tabs.post({ batch, type: 'batch' });
    cursor = res.cursor;
  }

  async function delta() {
    setState('delta');
    for (;;) {
      if (!cursor) return snapshot();
      const res = await api.changes(cursor);
      if (stopped) return;
      if (res.reset) return snapshot();
      await applyChanges(res);
      if (!res.more) return;
    }
  }

  async function snapshot() {
    setState('snapshot', { progress: { received: 0 } });
    abort = new AbortController();
    const stream = await api.snapshot(abort.signal);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const rows: LibraryRows = { albums: [], artists: [], playlistTracks: [], playlists: [], tracks: [] };
    let begin: Extract<SnapshotLine, { type: 'begin' }> | null = null;
    let end: Extract<SnapshotLine, { type: 'end' }> | null = null;
    let received = 0;
    let rest = '';

    const handle = (line: string) => {
      if (!line.trim()) return;
      let parsed: SnapshotLine;
      try {
        parsed = JSON.parse(line) as SnapshotLine;
      } catch {
        throw new Error('snapshot: malformed line');
      }
      if (parsed.type === 'begin') begin = parsed;
      else if (parsed.type === 'end') end = parsed;
      else if (parsed.type in BUCKET) {
        (rows[BUCKET[parsed.type]] as unknown[]).push(parsed.row);
        received += 1;
        if (received % 2000 === 0) status.setState({ progress: { received } });
      }
      // Неизвестные типы строк игнорируются (расширение формата).
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (stopped) {
          await reader.cancel();
          return;
        }
        rest += decoder.decode(value, { stream: !done });
        const lines = rest.split('\n');
        rest = lines.pop() ?? '';
        lines.forEach(handle);
        if (done) break;
      }
      handle(rest);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof Error && e.message.startsWith('snapshot:')) throw e;
      // Обрыв соединения посреди потока.
      throw new ApiError(0, 'network', e instanceof Error ? e.message : 'Snapshot stream failed');
    }

    // Снимок принят только с `end` и совпавшими счётчиками; иначе старые данные остаются нетронутыми.
    const final = end as Extract<SnapshotLine, { type: 'end' }> | null;
    const start = begin as Extract<SnapshotLine, { type: 'begin' }> | null;
    if (!start || !final) throw new Error('snapshot: incomplete (no end line)');
    for (const key of Object.keys(COUNT_KEY) as (keyof LibraryRows)[]) {
      if (final.counts[COUNT_KEY[key]] !== rows[key].length) throw new Error(`snapshot: count mismatch for ${key}`);
    }
    const meta = { cursor: start.cursor, schema: SYNC_SCHEMA, syncedAt: now() };
    await flush();
    await db.replaceAll({ ...rows, meta });
    store.getState().replaceAll(rows);
    tabs.post({ type: 'reload' });
    cursor = start.cursor;
  }

  async function loop() {
    try {
      do {
        again = false;
        if (forceSnapshot) {
          forceSnapshot = false;
          cursor = undefined;
        }
        await (cursor ? delta() : snapshot());
        if (stopped) return;
        failures = 0;
        setState('live', { error: null, lastSyncedAt: now(), progress: null });
      } while (again && !stopped);
    } catch (e) {
      again = false;
      if (!stopped) fail(e);
      else if (e instanceof ApiError && e.status === 401) fail(e);
    }
  }

  /** Запрашивает синхронизацию. Выполняется одна за раз; запрос во время работы — «повторить после». */
  function requestSync(_reason: string): void {
    if (stopped || !leader) return;
    clearRetry();
    if (running) {
      again = true;
      return;
    }
    running = loop().finally(() => {
      running = null;
    });
  }

  function onTabMessage(message: TabMessage) {
    if (leader || stopped) return;
    if (message.type === 'batch') {
      store.getState().applyBatch(message.batch);
      const at = message.batch.meta?.syncedAt;
      setState('live', { error: null, lastSyncedAt: at ?? now() });
    } else {
      // Лидер заменил всё снимком: в IndexedDB он уже записан.
      void db.loadAll().then(data => {
        if (stopped) return;
        store.getState().replaceAll(data);
        setState('live', { error: null, lastSyncedAt: data.meta.syncedAt ?? now() });
      });
    }
  }

  async function start(): Promise<void> {
    if (!stopped) return;
    stopped = false;
    setState('hydrating');
    try {
      const data = await db.loadAll();
      store.getState().hydrate(data);
      cursor = data.meta.schema === SYNC_SCHEMA ? data.meta.cursor : undefined;
      if (cursor) status.setState({ lastSyncedAt: data.meta.syncedAt ?? null });
    } catch (e) {
      // Не удалось прочитать локальные данные: начинаем с чистого листа (снимок).
      store.getState().hydrate({ albums: [], artists: [], playlistTracks: [], playlists: [], tracks: [] });
      cursor = undefined;
      status.setState({ error: e instanceof Error ? e : new Error(String(e)) });
    }
    if (stopped) return;
    setState(cursor ? 'live' : 'idle', {});

    const onOnline = () => requestSync('online');
    const onOffline = () => {
      if (!stopped && leader) setState('offline');
    };
    globalThis.addEventListener('online', onOnline);
    globalThis.addEventListener('offline', onOffline);
    // Возврат на передний план (visibilitychange, pageshow из bfcache, resume) — единый источник событий.
    const offForeground = lifecycle().on('foreground', () => requestSync('visible'));
    detach.push(
      offForeground,
      () => globalThis.removeEventListener('online', onOnline),
      () => globalThis.removeEventListener('offline', onOffline),
    );
    pollTimer = setInterval(() => requestSync('timer'), SAFETY_POLL_MS);

    tabs.onMessage(onTabMessage);
    tabs.lead(() => {
      if (stopped) return;
      leader = true;
      // Прежний лидер мог продвинуть курсор: берём актуальный из базы.
      starting = db
        .loadMeta()
        .then(meta => {
          if (meta.schema === SYNC_SCHEMA && meta.cursor) cursor = meta.cursor;
        })
        .catch(() => undefined)
        .finally(() => requestSync('start'));
    });
  }

  function stop(): void {
    stopped = true;
    leader = false;
    clearRetry();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    abort?.abort();
    dropBuffer();
    detach.splice(0).forEach(d => d());
    tabs.close();
  }

  /** Забыть курсор и взять свежий снимок (старые данные остаются на экране до его принятия). */
  function resetAndResync(): void {
    forceSnapshot = true;
    if (running) again = true;
    else requestSync('reset');
  }

  /** Мгновенные события WebSocket (подключает оболочка, шаг 38). */
  function handleEvent(e: EngineEvent): void {
    switch (e.type) {
      case 'sync.poke':
        requestSync('poke');
        break;
      case 'resync':
        albumProgress = new Map();
        downloadProgress = new Map();
        streamProgress = new Map();
        live.getState().clear();
        requestSync('resync');
        break;
      case 'track.status': {
        const ev = e as Extract<EngineEvent, { type: 'track.status' }>;
        patches.set(ev.track_id, { status: ev.status, status_reason: ev.reason });
        patchedAlbums.add(ev.album_id);
        schedule();
        break;
      }
      case 'job.progress': {
        const ev = e as Extract<EngineEvent, { type: 'job.progress' }>;
        albumProgress.set(ev.album_id, { done: ev.done, stage: ev.stage, total: ev.total });
        schedule();
        break;
      }
      case 'download.progress': {
        const ev = e as Extract<EngineEvent, { type: 'download.progress' }>;
        downloadProgress.set(ev.album_id, {
          bytes_done: ev.bytes_done,
          bytes_total: ev.bytes_total,
          down_bps: ev.down_bps,
          peers: ev.peers,
        });
        schedule();
        break;
      }
      case 'stream.progress': {
        const ev = e as Extract<EngineEvent, { type: 'stream.progress' }>;
        streamProgress.set(ev.track_id, {
          bytes_done: ev.bytes_done,
          bytes_total: ev.bytes_total,
          down_speed_bps: ev.down_speed_bps,
          peers: ev.peers,
        });
        schedule();
        break;
      }
      default:
        break;
    }
  }

  return {
    handleEvent,
    /** Завершается, когда текущая синхронизация закончилась (для тестов и ожидания в оболочке). */
    settled: async () => {
      await starting;
      while (running) await running;
      await flush();
    },
    requestSync,
    resetAndResync,
    start,
    status,
    stop,
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
