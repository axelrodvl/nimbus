import { createStore, type StoreApi } from 'zustand/vanilla';
import type { OfflineFileState } from '@/lib/db/types';
import type { LibraryState } from '@/lib/store/library';

export type OfflineFileStatus = {
  state: OfflineFileState;
  bytesDone: number;
  bytesTotal: number | null;
  mime: string;
  error: string | null;
};

/** Почему очередь стоит (`none` — не стоит). */
export type OfflineBlock = 'none' | 'offline' | 'paused' | 'wifi' | 'quota' | 'unauthorized';

export type OfflineStatus = {
  /** Есть ли в этом окружении офлайн-хранилище; интерфейс (шаг 47) скрывается, если `false`. */
  supported: boolean;
  files: Map<number, OfflineFileStatus>;
  /** Ключи закреплений `"<kind>:<id>"`. */
  pins: Set<string>;
  /** Когда закреплено (мс, по ключу): сортировка списка «На устройстве». */
  pinTimes: Record<string, number>;
  usage: { bytes: number; quota: number | null; limit: number };
  paused: boolean;
  queueLength: number;
  activeCount: number;
  blocked: OfflineBlock;
};

export type OfflineStatusStore = StoreApi<OfflineStatus>;

export const initialOfflineStatus = (supported = false): OfflineStatus => ({
  activeCount: 0,
  blocked: 'none',
  files: new Map(),
  paused: false,
  pins: new Set(),
  pinTimes: {},
  queueLength: 0,
  supported,
  usage: { bytes: 0, limit: 0, quota: null },
});

export const createOfflineStatusStore = (supported = false): OfflineStatusStore =>
  createStore<OfflineStatus>(() => initialOfflineStatus(supported));

/** Сериализуемый снимок для передачи между вкладками (`BroadcastChannel` не передаёт `Map`/`Set` между версиями кода). */
export type OfflineSnapshot = Omit<OfflineStatus, 'files' | 'pins' | 'supported'> & {
  files: [number, OfflineFileStatus][];
  pins: string[];
};

export const toSnapshot = (s: OfflineStatus): OfflineSnapshot => ({
  activeCount: s.activeCount,
  blocked: s.blocked,
  files: [...s.files],
  paused: s.paused,
  pins: [...s.pins],
  pinTimes: s.pinTimes,
  queueLength: s.queueLength,
  usage: s.usage,
});

export const fromSnapshot = (s: OfflineSnapshot): Partial<OfflineStatus> => ({
  ...s,
  files: new Map(s.files),
  pins: new Set(s.pins),
});

/** Состояние сущности для интерфейса. `downloading.progress` — 0…1 (0, если размеры неизвестны). */
export type OfflineItemState =
  | { kind: 'none' }
  | { kind: 'partial' }
  | { kind: 'queued' }
  | { kind: 'downloading'; progress: number }
  | { kind: 'done' }
  | { kind: 'failed' };

const NONE: OfflineItemState = { kind: 'none' };

export function trackOfflineState(s: OfflineStatus, trackId: number): OfflineItemState {
  const f = s.files.get(trackId);
  if (!f) return NONE;
  if (f.state === 'downloading') {
    return { kind: 'downloading', progress: f.bytesTotal ? Math.min(1, f.bytesDone / f.bytesTotal) : 0 };
  }
  return { kind: f.state };
}

/** Сводка по набору треков: всё скачано — `done`; идёт загрузка — `downloading`; ждёт — `queued`; часть — `partial`. */
export function aggregateOfflineState(s: OfflineStatus, trackIds: readonly number[]): OfflineItemState {
  let done = 0;
  let failed = 0;
  let queued = 0;
  let downloading = 0;
  let fraction = 0;
  for (const id of trackIds) {
    const f = s.files.get(id);
    if (!f) continue;
    if (f.state === 'done') {
      done++;
      fraction += 1;
    } else if (f.state === 'failed') failed++;
    else if (f.state === 'queued') queued++;
    else {
      downloading++;
      fraction += f.bytesTotal ? Math.min(1, f.bytesDone / f.bytesTotal) : 0;
    }
  }
  if (trackIds.length > 0 && done === trackIds.length) return { kind: 'done' };
  // Доля считается от всех загружаемых треков набора: готовые — целиком, ждущие — нулём, чтобы шкала не откатывалась.
  if (downloading > 0) {
    const counted = done + downloading + queued;
    return { kind: 'downloading', progress: counted > 0 ? Math.min(1, fraction / counted) : 0 };
  }
  if (queued > 0) return { kind: 'queued' };
  if (done > 0 || failed > 0) return { kind: 'partial' };
  return NONE;
}

/** Треки альбома, входящие в библиотеку, в порядке прослушивания (диск, номер). */
export function albumTrackIds(lib: LibraryState, albumId: number): number[] {
  const out: { id: number; disc: number; pos: number }[] = [];
  for (const id of lib.tracksByAlbum.get(albumId) ?? []) {
    const t = lib.tracks.get(id);
    if (t?.in_library) out.push({ disc: t.disc_no, id, pos: t.position });
  }
  return out.sort((a, b) => a.disc - b.disc || a.pos - b.pos || a.id - b.id).map(t => t.id);
}

/** Закрепление «Избранного» (динамического плейлиста) — `playlist:0`: настоящие id плейлистов начинаются с 1. */
export const FAVORITES_PIN_ID = 0;

/** Треки плейлиста в порядке воспроизведения (по возрастанию id строк), только существующие в библиотеке. */
export function playlistTrackIds(lib: LibraryState, playlistId: number): number[] {
  const rows = [...(lib.tracksByPlaylist.get(playlistId) ?? [])].sort((a, b) => a - b);
  const out: number[] = [];
  for (const rowId of rows) {
    const row = lib.playlistTracks.get(rowId);
    if (row && lib.tracks.has(row.track_id)) out.push(row.track_id);
  }
  return out;
}

export const albumOfflineState = (s: OfflineStatus, lib: LibraryState, albumId: number): OfflineItemState =>
  aggregateOfflineState(s, albumTrackIds(lib, albumId));

export const playlistOfflineState = (s: OfflineStatus, lib: LibraryState, playlistId: number): OfflineItemState =>
  aggregateOfflineState(s, playlistTrackIds(lib, playlistId));
