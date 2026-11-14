import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import {
  getAcquisitionSummary,
  getDownloads,
  getFailedJobs,
  listAcquisition,
  type AcquisitionPage,
  type AcquisitionState,
} from '@/lib/api/acquisition';
import { useConnectionState, useLiveEvent } from '@/lib/live/hooks';
import { flattenPages, trimLists, updateAlbumRow } from './cache';
import {
  ACQ_REFRESH_DEBOUNCE_MS,
  ACQ_ROOT,
  albumKey,
  downloadsKey,
  ENGINE_POLL_MS,
  jobsKey,
  listKey,
  summaryKey,
} from './keys';

/** Сводка по состояниям (`GET /api/acquisition/summary`): обновляется событиями, не опросом. */
export const useAcquisitionSummary = (enabled = true) =>
  useQuery({
    enabled,
    queryFn: ({ signal }) => getAcquisitionSummary(signal),
    queryKey: summaryKey,
    staleTime: 60_000,
  });

/** Альбомы в заданных состояниях страницами по курсору; `items` — без повторов. */
export function useAcquisitionList(states: readonly AcquisitionState[], enabled = true) {
  const query = useInfiniteQuery<
    AcquisitionPage,
    Error,
    InfiniteData<AcquisitionPage, string | null>,
    readonly unknown[],
    string | null
  >({
    enabled,
    getNextPageParam: page => page.next_cursor ?? undefined,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => listAcquisition({ cursor: pageParam, states }, signal),
    queryKey: listKey(states),
    staleTime: 30_000,
  });
  const items = useMemo(() => flattenPages(query.data), [query.data]);
  return { ...query, items };
}

/** Торренты движка и флаг паузы. Опрос раз в 2 с — только при `poll` (открыта вкладка «Торренты»). */
export const useEngineTorrents = (poll: boolean, enabled = true) =>
  useQuery({
    enabled,
    queryFn: ({ signal }) => getDownloads(signal),
    queryKey: downloadsKey,
    refetchInterval: poll ? ENGINE_POLL_MS : false,
    staleTime: 5000,
  });

/** Упавшие фоновые задачи. */
export const useFailedJobs = (enabled = true) =>
  useQuery({
    enabled,
    queryFn: ({ signal }) => getFailedJobs(signal),
    queryKey: jobsKey,
    staleTime: 30_000,
  });

/**
 * Состояние одного альбома на сервере (скачан / закреплён / прогресс) — запрос списка с фильтром `album_ids`.
 * `null` — сервер альбом не знает.
 */
export const useAlbumAcquisition = (albumId: number, enabled = true) =>
  useQuery({
    enabled,
    queryFn: async ({ signal }) => (await listAcquisition({ albumIds: [albumId] }, signal)).items[0] ?? null,
    queryKey: albumKey(albumId),
    staleTime: 15_000,
  });

/**
 * Живые обновления раздела (подключается один раз в оболочке):
 * `acquisition.changed` → сводка и открытые списки перезапрашиваются не чаще раза в секунду;
 * `download.progress` → строка альбома обновляется в кэше без запроса;
 * (пере)подключение сокета → всё перезапрашивается.
 */
export function useAcquisitionLiveSync(enabled = true): void {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = () => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      trimLists(qc);
      void qc.invalidateQueries({ queryKey: ACQ_ROOT, refetchType: 'active' });
    }, ACQ_REFRESH_DEBOUNCE_MS);
  };
  useLiveEvent('acquisition.changed', () => {
    if (enabled) refresh();
  });
  useLiveEvent<{
    type: string;
    album_id: number;
    bytes_done: number;
    bytes_total: number;
    down_bps: number;
    peers: number;
  }>('download.progress', e => {
    if (!enabled) return;
    updateAlbumRow(qc, e.album_id, item => ({
      ...item,
      download: {
        bytes_done: e.bytes_done,
        bytes_total: e.bytes_total,
        down_bps: e.down_bps,
        peers: e.peers,
        pinned: item.download?.pinned ?? true,
        state: item.download?.state ?? 'downloading',
      },
    }));
  });
  const connection = useConnectionState();
  const was = useRef(connection);
  useEffect(() => {
    if (enabled && connection === 'open' && was.current !== 'open') void qc.invalidateQueries({ queryKey: ACQ_ROOT });
    was.current = connection;
  }, [connection, enabled, qc]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
}
