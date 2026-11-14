import type { AudioSource } from '@/lib/player/audio/types';
import type { DownloadMessage, DownloadStart, Downloader, OfflineStorage } from '@/lib/offline/types';

/** `OfflineStorage` в памяти: файл — это только размер. */
export class MemoryStorage implements OfflineStorage {
  files = new Map<string, number>();
  supported = true;
  quota: number | null = null;
  /** Дополнительные «чужие» байты (кэши приложения), входящие в `usage`. */
  extra = 0;
  released: string[] = [];
  sourced: string[] = [];
  removed: string[] = [];
  failSource = false;

  isSupported = () => this.supported;
  list = async () => [...this.files.keys()];
  size = async (id: string) => this.files.get(id) ?? null;
  remove = async (id: string) => {
    this.removed.push(id);
    this.release(id);
    this.files.delete(id);
  };
  usage = async () => ({ bytes: this.extra + [...this.files.values()].reduce((a, b) => a + b, 0), quota: this.quota });
  source = async (id: string, mime: string): Promise<AudioSource> => {
    if (this.failSource) throw new Error('no file');
    this.sourced.push(id);
    return { mime, mode: 'direct', url: `blob:mem/${id}` };
  };
  release = (id: string) => void this.released.push(id);
}

/** Загрузчик, которым управляет тест: `start` запоминает, `emit` имитирует сообщения воркера. */
export class FakeDownloader implements Downloader {
  started: DownloadStart[] = [];
  aborted: string[] = [];
  private handlers = new Set<(m: DownloadMessage) => void>();
  constructor(readonly background = false) {}
  start = (p: DownloadStart) => void this.started.push(p);
  /** Тест может подменить, чтобы имитировать воркер, который ещё держит файл. */
  abort: (id: string) => void | Promise<void> = id => void this.aborted.push(id);
  on = (h: (m: DownloadMessage) => void) => {
    this.handlers.add(h);
    return () => void this.handlers.delete(h);
  };
  emit(m: DownloadMessage) {
    for (const h of [...this.handlers]) h(m);
  }
  /** Id треков, загрузка которых сейчас идёт (запущены и не завершены). */
  get startedIds(): number[] {
    return this.started.map(s => Number(s.trackId));
  }
}

import { vi } from 'vitest';
import type { OfflineFile, OfflinePin } from '@/lib/db/types';
import { emptyRows, type LibraryRows } from '@/lib/db/types';
import { createOfflineManager, type ManagerDeps, type OfflineDb, type OfflineTabMessage } from '@/lib/offline/manager';
import { createOfflineSettings, type OfflineSettingsStore } from '@/lib/offline/settings';
import { createOfflineStatusStore, type OfflineStatusStore } from '@/lib/offline/status';
import { createLibraryStore, type LibraryStore } from '@/lib/store/library';
import type { Tabs } from '@/lib/sync/tabs';
import { makeAlbum, makeArtist, makePlaylist, makePlaylistTrack, makeTrack } from './factories';

/** Офлайн-часть `Db` в памяти (без IndexedDB: тесты с fake timers не должны ждать её таймеры). */
export class MemOfflineDb implements OfflineDb {
  pins = new Map<string, OfflinePin>();
  files = new Map<number, OfflineFile>();
  offlineLoad = async () => ({ files: structuredClone([...this.files.values()]), pins: structuredClone([...this.pins.values()]) });
  offlinePinPut = async (p: OfflinePin) => void this.pins.set(p.key, structuredClone(p));
  offlinePinDelete = async (k: string) => void this.pins.delete(k);
  offlineFilePut = async (f: OfflineFile) => void this.files.set(f.track_id, structuredClone(f));
  offlineFileDelete = async (id: number) => void this.files.delete(id);
  offlineClear = async () => {
    this.pins.clear();
    this.files.clear();
  };
}

/** Вкладки: лидерство берётся сразу (`auto`) или вручную (`becomeLeader`); сообщения собираются в `posted`. */
export class FakeTabs implements Tabs<OfflineTabMessage> {
  posted: OfflineTabMessage[] = [];
  closed = false;
  private listener: ((m: OfflineTabMessage) => void) | null = null;
  private leadCb: (() => void) | null = null;
  constructor(private readonly auto = true) {}
  lead(cb: () => void) {
    this.leadCb = cb;
    if (this.auto) cb();
  }
  post(m: OfflineTabMessage) {
    this.posted.push(m);
  }
  onMessage(l: (m: OfflineTabMessage) => void) {
    this.listener = l;
  }
  close() {
    this.closed = true;
  }
  becomeLeader() {
    this.leadCb?.();
  }
  deliver(m: OfflineTabMessage) {
    this.listener?.(m);
  }
}

/** Библиотека: альбом 1 (треки 1–3), альбом 2 (треки 4–5), плейлист 1 (треки 2 и 4), трек 6 — в `adding`. */
export function offlineRows(): LibraryRows {
  return {
    ...emptyRows(),
    albums: [makeAlbum({ artist_id: 1, id: 1 }), makeAlbum({ artist_id: 1, id: 2 })],
    artists: [makeArtist({ id: 1 })],
    playlistTracks: [
      makePlaylistTrack({ id: 1, playlist_id: 1, track_id: 2 }),
      makePlaylistTrack({ id: 2, playlist_id: 1, track_id: 4 }),
    ],
    playlists: [makePlaylist({ id: 1 })],
    tracks: [
      makeTrack({ album_id: 1, id: 1, position: 1 }),
      makeTrack({ album_id: 1, id: 2, position: 2 }),
      makeTrack({ album_id: 1, id: 3, position: 3 }),
      makeTrack({ album_id: 2, id: 4, position: 1 }),
      makeTrack({ album_id: 2, id: 5, position: 2 }),
      makeTrack({ album_id: 2, id: 6, position: 3, status: 'adding' }),
    ],
  };
}

export type Net = { online: boolean; cellular: boolean; listeners: Set<() => void>; change(p: Partial<Pick<Net, 'online' | 'cellular'>>): void };

export type OfflineHarness = ReturnType<typeof offlineHarness>;

/** Менеджер со всем окружением в памяти (запускается `await h.start()`). Часы — под управлением теста (`vi.useFakeTimers`). */
export function offlineHarness(
  over: {
    rows?: LibraryRows;
    hydrated?: boolean;
    background?: boolean;
    tabsAuto?: boolean;
    pins?: OfflinePin[];
    files?: OfflineFile[];
    storage?: Record<string, number>;
    settings?: Partial<{ concurrency: number; limitBytes: number | null; wifiOnly: boolean }>;
    deps?: Partial<ManagerDeps>;
  } = {},
) {
  const db = new MemOfflineDb();
  for (const p of over.pins ?? []) db.pins.set(p.key, p);
  for (const f of over.files ?? []) db.files.set(f.track_id, f);
  const storage = new MemoryStorage();
  for (const [id, size] of Object.entries(over.storage ?? {})) storage.files.set(id, size);
  const downloader = new FakeDownloader(over.background ?? false);
  const library: LibraryStore = createLibraryStore();
  if (over.hydrated !== false) library.getState().hydrate(over.rows ?? offlineRows());
  const status: OfflineStatusStore = createOfflineStatusStore(true);
  const settings: OfflineSettingsStore = createOfflineSettings(null);
  if (over.settings) settings.update(over.settings);
  const tabs = new FakeTabs(over.tabsAuto ?? true);
  const net: Net = {
    cellular: false,
    change(p) {
      Object.assign(net, p);
      net.listeners.forEach(l => l());
    },
    listeners: new Set(),
    online: true,
  };
  const onUnauthorized = vi.fn();
  const manager = createOfflineManager({
    db,
    downloadUrl: id => `/api/tracks/${id}/stream?download=1`,
    downloader,
    headers: () => ({}),
    library,
    network: {
      cellular: () => net.cellular,
      online: () => net.online,
      subscribe: l => {
        net.listeners.add(l);
        return () => void net.listeners.delete(l);
      },
    },
    onUnauthorized,
    settings,
    status,
    storage,
    tabs,
    ...over.deps,
  });
  return {
    db,
    downloader,
    library,
    manager,
    net,
    onUnauthorized,
    settings,
    status,
    storage,
    tabs,
    /** Запуск и ожидание первой сверки. */
    async start() {
      await manager.start();
      await manager.settled();
    },
    /** Дождаться фоновых операций менеджера. */
    settle: () => manager.settled(),
    /** Сообщение воркера → менеджер → ожидание обработки. */
    async emit(m: Parameters<FakeDownloader['emit']>[0]) {
      downloader.emit(m);
      await manager.settled();
    },
    file: (id: number) => status.getState().files.get(id),
    state: (id: number) => status.getState().files.get(id)?.state,
  };
}

export const offlineFile = (trackId: number, over: Partial<OfflineFile> = {}): OfflineFile => ({
  attempts: 0,
  bytes_done: 0,
  bytes_total: null,
  completed_at: null,
  error: null,
  etag: null,
  mime: 'audio/flac',
  next_attempt_at: null,
  resumable: false,
  state: 'queued',
  track_id: trackId,
  ...over,
});
