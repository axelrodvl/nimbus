import { useMemo, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { appData } from '@/lib/app-data';
import { useOnline } from '@/lib/live/hooks';
import { useCanPlay } from '@/lib/player/hooks';
import { useAlbumTracks } from '@/lib/store/hooks';
import {
  batchProgress,
  decodeSummary,
  downloadedSets,
  encodeSummary,
  EMPTY_SUMMARY,
  hasPendingDownloads,
  type DownloadedSets,
  remainingUnits,
  summarize,
  summarizePins,
  type OfflineSummary,
  type PinSummary,
} from './derive';
import { offline } from './index';
import {
  albumTrackIds,
  playlistTrackIds,
  trackOfflineState,
  type OfflineItemState,
  type OfflineStatus,
} from './status';

/** Срез состояния офлайн-хранилища. */
export const useOfflineStatus = <T>(select: (s: OfflineStatus) => T): T => useStore(offline().status, select);

/** Есть ли в этом окружении офлайн-хранилище (если нет — интерфейс скачивания скрыт). */
export const useOfflineSupported = (): boolean => useOfflineStatus(s => s.supported);

/** Подписка на оба источника: состояние файлов и библиотеку (состав альбомов и плейлистов). */
function subscribeBoth(cb: () => void): () => void {
  const a = offline().status.subscribe(cb);
  const b = appData().library.subscribe(cb);
  return () => {
    a();
    b();
  };
}

const NONE_KEY = encodeSummary(EMPTY_SUMMARY);

/**
 * Сводка набора треков. `getIds` вызывается при каждом изменении store, поэтому должна быть дешёвой; компонент
 * перерисовывается, только когда изменилась строка сводки (процент, счётчики, размер).
 */
export function useOfflineSummary(getIds: () => readonly number[]): OfflineSummary {
  const key = useSyncExternalStore(
    subscribeBoth,
    () => {
      const s = offline().status.getState();
      return s.supported ? encodeSummary(summarize(s, getIds())) : NONE_KEY;
    },
    () => NONE_KEY,
  );
  return useMemo(() => decodeSummary(key), [key]);
}

export const useAlbumOffline = (albumId: number): OfflineSummary =>
  useOfflineSummary(() => albumTrackIds(appData().library.getState(), albumId));

export const usePlaylistOffline = (playlistId: number): OfflineSummary =>
  useOfflineSummary(() => playlistTrackIds(appData().library.getState(), playlistId));

/** Сводка по готовому списку id (например, «Избранное»). */
export function useTracksOffline(ids: readonly number[]): OfflineSummary {
  return useOfflineSummary(() => ids);
}

/** Закреплена ли сущность или (для альбома/плейлиста) хотя бы один из её треков по отдельности. */
export function usePinned(kind: 'track' | 'album' | 'playlist', id: number, trackIds: readonly number[]): boolean {
  return useOfflineStatus(s => {
    if (s.pins.has(`${kind}:${id}`)) return true;
    return kind !== 'track' && trackIds.some(t => s.pins.has(`track:${t}`));
  });
}

/** Состояние одного трека (строка списка подписывается только на него). */
export function useTrackOffline(trackId: number): OfflineItemState {
  const key = useStore(offline().status, s => {
    const st = trackOfflineState(s, trackId);
    return st.kind === 'downloading' ? `downloading|${Math.round(st.progress * 100)}` : st.kind;
  });
  return useMemo<OfflineItemState>(() => {
    const [kind, p] = key.split('|');
    return kind === 'downloading' ? { kind, progress: Number(p) / 100 } : ({ kind } as OfflineItemState);
  }, [key]);
}

/** Закрепления для вкладки «На устройстве». */
export function usePinSummaries(): PinSummary[] {
  const status = useStore(offline().status, s => s);
  const lib = useStore(appData().library, s => s);
  const { selectors } = appData();
  return useMemo(
    () =>
      summarizePins(
        status,
        lib,
        selectors.favorites(lib).map(t => t.id),
      ),
    [status, lib, selectors],
  );
}

/** Общий прогресс текущей пачки загрузок: `null`, когда очередь пуста. */
export function useQueueProgress(): number | null {
  const [batch, setBatch] = useState(0);
  const pending = useOfflineStatus(hasPendingDownloads);
  // Дробное «осталось» меняется часто; округляем до сотых, чтобы индикатор не дёргал рендер.
  const remaining = useOfflineStatus(s => Math.round(remainingUnits(s) * 100) / 100);
  // «Начало пачки» — наибольшее число оставшихся с момента, когда очередь была пуста (производное состояние).
  const next = pending ? Math.max(batch, remaining) : 0;
  if (next !== batch) setBatch(next);
  return pending ? batchProgress(remaining, next) : null;
}

/** Хоть одна загрузка идёт или ждёт — для счётчика вкладки и индикатора. */
export const usePendingCount = (): number => useOfflineStatus(s => s.activeCount + s.queueLength);

/** Без связи альбом, в котором нечего играть (ничего не скачано), в сетках приглушается. */
export function useAlbumDimmed(albumId: number): boolean {
  const online = useOnline();
  const canPlay = useCanPlay();
  const tracks = useAlbumTracks(albumId);
  return !online && !tracks.some(canPlay);
}

/** Что скачано на устройство (для фильтра «Только скачанные»); без `enabled` — `null`, пересчёта нет. */
export function useDownloadedSets(enabled: boolean): DownloadedSets | null {
  const files = useOfflineStatus(s => (enabled ? s.files : null));
  const lib = useStore(appData().library, s => (enabled ? s : null));
  return useMemo(() => (files && lib ? downloadedSets(files, lib) : null), [files, lib]);
}
