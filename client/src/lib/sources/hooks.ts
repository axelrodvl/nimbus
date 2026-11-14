import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getAlbumTorrents, getTorrentFiles, getTrackSources } from '@/lib/api/sources';
import { useLiveEvent } from '@/lib/live/hooks';
import {
  albumTorrentsKey,
  SOURCES_REFRESH_DEBOUNCE_MS,
  SOURCES_STALE_MS,
  torrentFilesKey,
  trackSourcesKey,
} from './keys';

export const useAlbumTorrents = (albumId: number, enabled = true) =>
  useQuery({
    enabled,
    queryFn: ({ signal }) => getAlbumTorrents(albumId, signal),
    queryKey: albumTorrentsKey(albumId),
    staleTime: SOURCES_STALE_MS,
  });

export const useTrackSources = (trackId: number, enabled = true) =>
  useQuery({
    enabled,
    queryFn: ({ signal }) => getTrackSources(trackId, signal),
    queryKey: trackSourcesKey(trackId),
    staleTime: SOURCES_STALE_MS,
  });

export const useTorrentFiles = (torrentId: number, enabled = true) =>
  useQuery({
    enabled,
    queryFn: ({ signal }) => getTorrentFiles(torrentId, signal),
    queryKey: torrentFilesKey(torrentId),
    staleTime: SOURCES_STALE_MS,
  });

/**
 * Обновляет источники альбома по событиям `track.status` и `job.progress` этого альбома: серия событий — один запрос
 * через секунду. Обновляются список раздач и (если открыт диалог) источники треков альбома.
 */
export function useSourcesRefresh(albumId: number, enabled = true): void {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = (eventAlbum: number | undefined) => {
    if (!enabled || eventAlbum !== albumId || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({ queryKey: albumTorrentsKey(albumId) });
      void queryClient.invalidateQueries({ queryKey: ['track-sources'] });
    }, SOURCES_REFRESH_DEBOUNCE_MS);
  };
  useLiveEvent<{ type: string; album_id?: number }>('track.status', e => refresh(e.album_id));
  useLiveEvent<{ type: string; album_id?: number }>('job.progress', e => refresh(e.album_id));
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
}
