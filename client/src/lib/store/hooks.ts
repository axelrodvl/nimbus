import { useMemo, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { appData } from '@/lib/app-data';
import type { LibraryState } from './library';
import { createThrottledSource } from './throttled';
import type { LiveState } from './live';
import type {
  AlbumView,
  ArtistView,
  MbidIndex,
  PlaylistCard,
  PlaylistEntry,
  SearchResult,
  TrackStatus,
  TrackView,
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
export const useArtistView = (id: number): ArtistView | undefined =>
  useLibrary(s => appData().selectors.artistView(s, id));
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
/** Треки альбомов артиста библиотеки (для «Слушать» в шапке артиста). */
export const useArtistTracks = (artistId: number): TrackView[] =>
  useLibrary(s => appData().selectors.artistTracks(s, artistId));
export const useAlbumTracks = (albumId: number): TrackView[] =>
  useLibrary(s => appData().selectors.albumTracks(s, albumId));
export const usePlaylistTracks = (playlistId: number): PlaylistEntry[] =>
  useLibrary(s => appData().selectors.playlistTracks(s, playlistId));
export const usePlaylistCards = (): PlaylistCard[] => useLibrary(s => appData().selectors.playlistCards(s));
export const usePlaylistCard = (id: number | 'favorites'): PlaylistCard | undefined =>
  useLibrary(s => appData().selectors.playlistCard(s, id));
/** В каких плейлистах уже есть трек. */
export const usePlaylistsOfTrack = (trackId: number): ReadonlySet<number> =>
  useLibrary(s => appData().selectors.playlistsOfTrack(s, trackId));
export const useRecentlyPlayedAlbums = (limit: number): AlbumView[] =>
  useLibrary(s => appData().selectors.recentlyPlayedAlbums(s, limit));
export const useFavorites = (): TrackView[] => useLibrary(s => appData().selectors.favorites(s));
export const useSearchLocal = (query: string, limit: number): SearchResult =>
  useLibrary(s => appData().selectors.searchLocal(s, query, limit));

/** Индекс `mbid → id` объектов библиотеки (для пометки результатов поиска). */
export const useMbidIndex = (): MbidIndex => useLibrary(s => appData().selectors.mbidIndex(s));

/** Эфемерные live-данные (прогресс поиска и буферизации). */
export const useLive = <T>(select: (s: LiveState) => T): T => useStore(appData().live, select);

const LIST_THROTTLE_MS = 250;

const statusKeyOf = (statuses?: readonly TrackStatus[]) => (statuses?.length ? [...statuses].sort().join(',') : '');
const statusesOf = (key: string) => (key ? (key.split(',') as TrackStatus[]) : undefined);

type ListKind = 'albums' | 'artists' | 'tracks';
type ListOf = { albums: AlbumView[]; artists: ArtistView[]; tracks: TrackView[] };

/**
 * Список библиотеки для длинных экранов: пересчитывается не чаще раза в 250 мс (серия событий статуса
 * не пересчитывает 25 000 строк на каждое). Строки подписываются на свои треки сами (`useTrackView`).
 */
export function useLibraryList<K extends ListKind>(kind: K, statuses?: readonly TrackStatus[]): ListOf[K] {
  const key = statusKeyOf(statuses);
  const source = useMemo(
    () =>
      createThrottledSource(
        appData().library,
        s => {
          const { selectors } = appData();
          const st = statusesOf(key);
          if (kind === 'albums') return selectors.libraryAlbums(s, st);
          if (kind === 'artists') return selectors.libraryArtists(s, st);
          return selectors.libraryTracks(s, st);
        },
        LIST_THROTTLE_MS,
      ),
    [kind, key],
  );
  return useSyncExternalStore(source.subscribe, source.getSnapshot) as ListOf[K];
}

export type LibraryCounts = { albums: number; artists: number; playlists: number; tracks: number };

/** Размеры списков библиотеки (счётчики во вкладках). */
export function useLibraryCounts(): LibraryCounts {
  const source = useMemo(
    () =>
      createThrottledSource(
        appData().library,
        (s): LibraryCounts => {
          const { selectors } = appData();
          return {
            albums: selectors.libraryAlbums(s).length,
            artists: selectors.libraryArtists(s).length,
            playlists: selectors.playlistCards(s).length,
            tracks: selectors.libraryTracks(s).length,
          };
        },
        LIST_THROTTLE_MS,
        (a, b) =>
          a.albums === b.albums && a.artists === b.artists && a.playlists === b.playlists && a.tracks === b.tracks,
      ),
    [],
  );
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}

/** Прогресс поиска раздач по альбому (`job.progress`). */
export const useAlbumProgress = (albumId: number) => useLive(s => s.albumProgress.get(albumId));

/** Прогресс закрепленной загрузки альбома на сервер (`download.progress`). */
export const useDownloadProgress = (albumId: number) => useLive(s => s.downloadProgress.get(albumId));
