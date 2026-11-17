import { createStore, type StoreApi } from 'zustand/vanilla';

export type AlbumProgress = { stage: 'searching' | 'verifying'; done: number; total: number };
export type StreamProgress = {
  bytes_done: number;
  bytes_total: number;
  peers: number;
  down_speed_bps: number;
};

/** Агрегатный прогресс загрузки альбома на сервер (`download.progress`). */
export type DownloadProgress = { bytes_done: number; bytes_total: number; down_bps: number; peers: number };

export type LiveState = {
  /** Прогресс закреплённых загрузок по альбомам (`download.progress`). */
  downloadProgress: ReadonlyMap<number, DownloadProgress>;
  /** Прогресс поиска/проверки по альбомам (`job.progress`). */
  albumProgress: ReadonlyMap<number, AlbumProgress>;
  /** Прогресс буферизации потока по трекам (`stream.progress`). */
  streamProgress: ReadonlyMap<number, StreamProgress>;
  /**
   * Пачка прогресса одним `set`: каждая затронутая карта копируется один раз.
   * Завершённые записи (проверка, загрузка, буфер) убираются; `dropAlbums` — убрать прогресс альбомов.
   */
  applyProgress(batch: {
    album?: ReadonlyMap<number, AlbumProgress>;
    download?: ReadonlyMap<number, DownloadProgress>;
    stream?: ReadonlyMap<number, StreamProgress>;
    dropAlbums?: Iterable<number>;
  }): void;
  setAlbumProgress(albumId: number, p: AlbumProgress): void;
  setDownloadProgress(albumId: number, p: DownloadProgress): void;
  setStreamProgress(trackId: number, p: StreamProgress): void;
  clear(): void;
};

export type LiveStore = StoreApi<LiveState>;

/** Эфемерное состояние live-событий. Не сохраняется нигде. */
export function createLiveStore(): LiveStore {
  return createStore<LiveState>()(set => ({
    albumProgress: new Map(),
    applyProgress({ album, download, dropAlbums, stream }) {
      const drop = dropAlbums ? [...dropAlbums] : [];
      set(s => {
        const next: Partial<LiveState> = {};
        if (album?.size || drop.length) {
          const m = new Map(s.albumProgress);
          for (const [id, p] of album ?? []) {
            // Завершённый этап проверки больше не показываем.
            if (p.stage === 'verifying' && p.total > 0 && p.done >= p.total) m.delete(id);
            else m.set(id, p);
          }
          drop.forEach(id => m.delete(id));
          next.albumProgress = m;
        }
        if (download?.size) {
          const m = new Map(s.downloadProgress);
          for (const [id, p] of download) {
            if (p.bytes_total > 0 && p.bytes_done >= p.bytes_total) m.delete(id);
            else m.set(id, p);
          }
          next.downloadProgress = m;
        }
        if (stream?.size) {
          const m = new Map(s.streamProgress);
          for (const [id, p] of stream) {
            if (p.bytes_total > 0 && p.bytes_done >= p.bytes_total) m.delete(id);
            else m.set(id, p);
          }
          next.streamProgress = m;
        }
        return Object.keys(next).length ? next : s; // ничего не изменилось — подписчиков не будить
      });
    },
    clear: () => set({ albumProgress: new Map(), downloadProgress: new Map(), streamProgress: new Map() }),
    downloadProgress: new Map(),
    setDownloadProgress(albumId, p) {
      set(s => {
        const next = new Map(s.downloadProgress);
        next.set(albumId, p);
        return { downloadProgress: next };
      });
    },
    setAlbumProgress(albumId, p) {
      set(s => {
        const next = new Map(s.albumProgress);
        // Завершённый этап проверки больше не показываем.
        if (p.stage === 'verifying' && p.total > 0 && p.done >= p.total) next.delete(albumId);
        else next.set(albumId, p);
        return { albumProgress: next };
      });
    },
    setStreamProgress(trackId, p) {
      set(s => {
        const next = new Map(s.streamProgress);
        // Буфер заполнен — индикатор не нужен.
        if (p.bytes_total > 0 && p.bytes_done >= p.bytes_total) next.delete(trackId);
        else next.set(trackId, p);
        return { streamProgress: next };
      });
    },
    streamProgress: new Map(),
  }));
}
