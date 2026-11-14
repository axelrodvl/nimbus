import type { LibraryState } from '@/lib/store/library';
import {
  aggregateOfflineState,
  albumTrackIds,
  FAVORITES_PIN_ID,
  playlistTrackIds,
  type OfflineItemState,
  type OfflineFileStatus,
  type OfflineStatus,
} from './status';

/** Сводка по набору треков для шапок и кнопок: общее состояние, сколько скачано из скольких, сколько байт на устройстве. */
export type OfflineSummary = { state: OfflineItemState; done: number; total: number; bytes: number };

export const EMPTY_SUMMARY: OfflineSummary = { bytes: 0, done: 0, state: { kind: 'none' }, total: 0 };

export function summarize(s: OfflineStatus, ids: readonly number[]): OfflineSummary {
  let done = 0;
  let bytes = 0;
  for (const id of ids) {
    const f = s.files.get(id);
    if (!f) continue;
    if (f.state === 'done') done++;
    bytes += f.bytesDone;
  }
  return { bytes, done, state: aggregateOfflineState(s, ids), total: ids.length };
}

/**
 * Сводка строкой: компоненты подписываются на строку, а не на объект, и перерисовываются, только когда
 * изменилось видимое (доля — до процента).
 */
export function encodeSummary(x: OfflineSummary): string {
  const progress = x.state.kind === 'downloading' ? Math.round(x.state.progress * 100) : 0;
  return `${x.state.kind}|${progress}|${x.done}|${x.total}|${x.bytes}`;
}

export function decodeSummary(key: string): OfflineSummary {
  const [kind, progress, done, total, bytes] = key.split('|');
  const state: OfflineItemState =
    kind === 'downloading'
      ? { kind, progress: Number(progress) / 100 }
      : { kind: kind as Exclude<OfflineItemState['kind'], 'downloading'> };
  return { bytes: Number(bytes), done: Number(done), state, total: Number(total) };
}

export type PinKind = 'track' | 'album' | 'playlist';

export function parsePinKey(key: string): { kind: PinKind; id: number } {
  const [kind, id] = key.split(':');
  return { id: Number(id), kind: kind as PinKind };
}

export type PinSummary = OfflineSummary & {
  key: string;
  kind: PinKind;
  id: number;
  /** Название; `null` — «Избранное» (название — перевод) или сущность исчезла из библиотеки. */
  title: string | null;
  favorites: boolean;
  /** Сущности больше нет в библиотеке (сверка скоро снимет закрепление). */
  missing: boolean;
  /** Сколько треков закрепления окончательно не скачалось. */
  failed: number;
  trackIds: number[];
  pinnedAt: number;
};

/** Закрепления для вкладки «На устройстве»: что закреплено, сколько скачано и сколько места занимает. */
export function summarizePins(s: OfflineStatus, lib: LibraryState, favoriteIds: readonly number[]): PinSummary[] {
  const out: PinSummary[] = [];
  for (const key of s.pins) {
    const { id, kind } = parsePinKey(key);
    let title: string | null = null;
    let trackIds: number[];
    let missing = false;
    const favorites = kind === 'playlist' && id === FAVORITES_PIN_ID;
    if (kind === 'track') {
      const t = lib.tracks.get(id);
      title = t?.title ?? null;
      trackIds = t ? [id] : [];
      missing = !t;
    } else if (kind === 'album') {
      const a = lib.albums.get(id);
      title = a?.title ?? null;
      trackIds = a ? albumTrackIds(lib, id) : [];
      missing = !a;
    } else if (favorites) {
      trackIds = [...favoriteIds];
    } else {
      const p = lib.playlists.get(id);
      title = p?.name ?? null;
      trackIds = p ? playlistTrackIds(lib, id) : [];
      missing = !p;
    }
    const failed = trackIds.filter(t => s.files.get(t)?.state === 'failed').length;
    out.push({
      ...summarize(s, trackIds),
      failed,
      favorites,
      id,
      key,
      kind,
      missing,
      pinnedAt: s.pinTimes[key] ?? 0,
      title,
      trackIds,
    });
  }
  return out;
}

export type PinSort = 'date' | 'size';

export function sortPins(pins: readonly PinSummary[], by: PinSort): PinSummary[] {
  const cmp =
    by === 'size'
      ? (a: PinSummary, b: PinSummary) => b.bytes - a.bytes
      : (a: PinSummary, b: PinSummary) => b.pinnedAt - a.pinnedAt;
  return [...pins].sort((a, b) => cmp(a, b) || a.key.localeCompare(b.key));
}

/** Сколько «треков-эквивалентов» ещё осталось скачать: ожидающие целиком, идущие — недостающей долей. */
export function remainingUnits(s: OfflineStatus): number {
  let left = 0;
  for (const f of s.files.values()) {
    if (f.state === 'queued') left += 1;
    else if (f.state === 'downloading') left += 1 - (f.bytesTotal ? Math.min(1, f.bytesDone / f.bytesTotal) : 0);
  }
  return left;
}

/** Общий прогресс текущей пачки загрузок 0…1: `batch` — наибольшее число «осталось» с начала пачки. */
export const batchProgress = (remaining: number, batch: number): number =>
  batch > 0 ? Math.min(1, Math.max(0, 1 - remaining / batch)) : 0;

/** Нужен ли индикатору показ: есть скачивающиеся или ожидающие треки. */
export const hasPendingDownloads = (s: OfflineStatus): boolean => s.activeCount > 0 || s.queueLength > 0;

/** Что целиком скачано на устройство: треки, альбомы (все треки) и артисты (хотя бы один трек). */
export type DownloadedSets = { tracks: Set<number>; albums: Set<number>; artists: Set<number> };

export function downloadedSets(files: ReadonlyMap<number, OfflineFileStatus>, lib: LibraryState): DownloadedSets {
  const out: DownloadedSets = { albums: new Set(), artists: new Set(), tracks: new Set() };
  const candidates = new Set<number>();
  for (const [id, f] of files) {
    const t = f.state === 'done' ? lib.tracks.get(id) : undefined;
    if (!t) continue;
    out.tracks.add(id);
    out.artists.add(t.artist_id);
    candidates.add(t.album_id);
  }
  for (const albumId of candidates) {
    const ids = albumTrackIds(lib, albumId);
    if (ids.length > 0 && ids.every(id => out.tracks.has(id))) out.albums.add(albumId);
  }
  return out;
}

export type QueueStatus = {
  key: 'paused' | 'offline' | 'wifi' | 'quota' | 'unauthorized' | 'active' | 'failed' | 'idle';
  active: number;
  queued: number;
  failed: number;
};

/** Что показывать о состоянии очереди: причина остановки (если есть что качать), ход работы, неудачи или покой. */
export function queueStatus(s: OfflineStatus): QueueStatus {
  let failed = 0;
  for (const f of s.files.values()) if (f.state === 'failed') failed++;
  const waiting = s.activeCount + s.queueLength;
  const base = { active: s.activeCount, failed, queued: s.queueLength };
  if (s.blocked === 'paused') return { ...base, key: 'paused' };
  if (s.blocked !== 'none' && waiting > 0) return { ...base, key: s.blocked };
  if (waiting > 0) return { ...base, key: 'active' };
  return { ...base, key: failed > 0 ? 'failed' : 'idle' };
}

/** Число файлов, полностью скачанных на устройство. */
export function doneCount(s: OfflineStatus): number {
  let n = 0;
  for (const f of s.files.values()) if (f.state === 'done') n++;
  return n;
}
