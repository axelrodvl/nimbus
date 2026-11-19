import { useMemo, useSyncExternalStore, type DependencyList } from 'react';
import { useStore } from 'zustand';
import { appData } from '@/lib/app-data';
import type { AlbumServerState } from '@/lib/acquisition/server-state';
import type { LibraryState } from './library';
import { createThrottledSource } from './throttled';
import type { LiveState } from './live';
import {
  statusKey,
  type AlbumView,
  type ArtistView,
  type MbidIndex,
  type PlaylistCard,
  type PlaylistEntry,
  type SearchResult,
  type TrackStatus,
  type TrackView,
} from './selectors';

// Тонкие React-хуки поверх store. Селекторы возвращают мемоизированные ссылки, поэтому лишних перерисовок нет.

function useLibrary<T>(select: (s: LibraryState) => T): T {
  return useStore(appData().library, select);
}

/** Данные из локальной базы уже загружены (экраны могут рисовать). */
export const useHydrated = (): boolean => useLibrary(s => s.hydrated);

/** Число строк в локальной библиотеке (0 — данных ещё нет). */
export const useRowCount = (): number => useLibrary(s => s.artists.size + s.tracks.size);

export const useAlbumView = (id: number): AlbumView | undefined =>
  useLibrary(s => appData().selectors.albumView(s, id));
/** Состояние альбома на сервере (скачан / закреплён / качается) — из store, без запроса; `null` — сервер его не знает. */
export const useAlbumServerState = (id: number): AlbumServerState | null =>
  useLibrary(s => appData().selectors.albumServer(s, id));
export const useArtistView = (id: number): ArtistView | undefined =>
  useLibrary(s => appData().selectors.artistView(s, id));
/** Признак фото артиста по `mbid` из store: `'yes'`/`'no'`, `null` — не искали, `undefined` — артиста в store нет. */
export const useArtistImage = (mbid: string): string | null | undefined =>
  useLibrary(s => appData().selectors.artistImage(s, mbid));
export const useTrackView = (id: number): TrackView | undefined =>
  useLibrary(s => appData().selectors.trackView(s, id));
export const useLibraryArtists = (statuses?: readonly TrackStatus[]): ArtistView[] =>
  useLibrary(s => appData().selectors.libraryArtists(s, statuses));
export const useLibraryAlbums = (statuses?: readonly TrackStatus[]): AlbumView[] =>
  useLibrary(s => appData().selectors.libraryAlbums(s, statuses));
export const useLibraryTracks = (statuses?: readonly TrackStatus[]): TrackView[] =>
  useLibrary(s => appData().selectors.libraryTracks(s, statuses));
export const useArtistAlbums = (artistId: number, libraryOnly = false): AlbumView[] =>
  useLibrary(s => appData().selectors.artistAlbums(s, artistId, libraryOnly));
/**
 * Треки альбома по MBID группы релизов — в библиотеке он или нет (альбом из каталога, который открывали или слушали).
 * Пустой список — альбома в store ещё нет.
 */
export const useAlbumTracksByMbid = (mbid: string): TrackView[] =>
  useLibrary(s => {
    for (const a of s.albums.values()) if (a.mbid === mbid) return appData().selectors.albumTracks(s, a.id);
    return EMPTY_TRACKS;
  });
const EMPTY_TRACKS: TrackView[] = [];

/** Треки альбомов артиста библиотеки (для «Слушать» в шапке артиста). */
export const useArtistTracks = (artistId: number): TrackView[] =>
  useLibrary(s => appData().selectors.artistTracks(s, artistId));
export const useAlbumTracks = (albumId: number): TrackView[] =>
  useLibrary(s => appData().selectors.albumTracks(s, albumId));
export const usePlaylistTracks = (playlistId: number): PlaylistEntry[] =>
  useLibrary(s => appData().selectors.playlistTracks(s, playlistId));
/** В каких плейлистах уже есть трек. */
export const usePlaylistsOfTrack = (trackId: number): ReadonlySet<number> =>
  useLibrary(s => appData().selectors.playlistsOfTrack(s, trackId));

/** Эфемерные live-данные (прогресс поиска и буферизации). */
export const useLive = <T>(select: (s: LiveState) => T): T => useStore(appData().live, select);

const LIST_THROTTLE_MS = 250;

const statusesOf = (key: string) => (key ? (key.split(',') as TrackStatus[]) : undefined);

export type ListKind = 'albums' | 'artists' | 'tracks';
export type ListOf = { albums: AlbumView[]; artists: ArtistView[]; tracks: TrackView[] };

/**
 * Значение по всей библиотеке, пересчитываемое не чаще раза в 250 мс (серия событий статуса не пересчитывает
 * десятки тысяч строк на каждое). `deps` — аргументы `select`: при их смене источник создаётся заново и первое
 * значение вычисляется сразу. Точечные хуки (`useTrackView` и др.) остаются мгновенными.
 */
export function useThrottledLibrary<T>(
  select: (s: LibraryState) => T,
  deps: DependencyList,
  isEqual?: (a: T, b: T) => boolean,
): T {
  // Аргументы — примитивы: ключ из них заменяет список зависимостей (его `useMemo` требует литералом).
  const argsKey = JSON.stringify(deps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(() => createThrottledSource(appData().library, select, LIST_THROTTLE_MS, isEqual), [argsKey]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}

export const usePlaylistCards = (): PlaylistCard[] =>
  useThrottledLibrary(s => appData().selectors.playlistCards(s), []);
export const usePlaylistCard = (id: number | 'favorites'): PlaylistCard | undefined =>
  useThrottledLibrary(s => appData().selectors.playlistCard(s, id), [id]);
export const useRecentlyPlayedAlbums = (limit: number): AlbumView[] =>
  useThrottledLibrary(s => appData().selectors.recentlyPlayedAlbums(s, limit), [limit]);
export const useFavorites = (): TrackView[] => useThrottledLibrary(s => appData().selectors.favorites(s), []);
export const useSearchLocal = (query: string, limit: number): SearchResult =>
  useThrottledLibrary(s => appData().selectors.searchLocal(s, query, limit), [query, limit]);
/** Индекс `mbid → id` объектов библиотеки (для пометки результатов поиска). */
export const useMbidIndex = (): MbidIndex => useThrottledLibrary(s => appData().selectors.mbidIndex(s), []);

/**
 * Список библиотеки для длинных экранов. Строки подписываются на свои треки сами (`useTrackView`).
 */
export function useLibraryList<K extends ListKind>(kind: K, statuses?: readonly TrackStatus[]): ListOf[K] {
  const key = statusKey(statuses);
  return useThrottledLibrary(
    s => {
      const { selectors } = appData();
      const st = statusesOf(key);
      if (kind === 'albums') return selectors.libraryAlbums(s, st);
      if (kind === 'artists') return selectors.libraryArtists(s, st);
      return selectors.libraryTracks(s, st);
    },
    [kind, key],
  ) as ListOf[K];
}

export type LibraryCounts = { albums: number; artists: number; playlists: number; tracks: number };

/** Размеры списков библиотеки (счётчики во вкладках). */
export function useLibraryCounts(): LibraryCounts {
  return useThrottledLibrary(
    (s): LibraryCounts => {
      const { selectors } = appData();
      return {
        albums: selectors.libraryAlbums(s).length,
        artists: selectors.libraryArtists(s).length,
        playlists: selectors.playlistCards(s).length,
        tracks: selectors.libraryTracks(s).length,
      };
    },
    [],
    (a, b) => a.albums === b.albums && a.artists === b.artists && a.playlists === b.playlists && a.tracks === b.tracks,
  );
}

/** Прогресс поиска раздач по альбому (`job.progress`). */
export const useAlbumProgress = (albumId: number) => useLive(s => s.albumProgress.get(albumId));

/** Прогресс закрепленной загрузки альбома на сервер (`download.progress`). */
export const useDownloadProgress = (albumId: number) => useLive(s => s.downloadProgress.get(albumId));
