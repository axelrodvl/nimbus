import { useStore } from 'zustand';
import { appData } from '@/lib/app-data';
import type { LibraryState } from './library';
import type { LiveState } from './live';
import type { AlbumView, ArtistView, PlaylistEntry, SearchResult, TrackStatus, TrackView } from './selectors';

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
export const useAlbumTracks = (albumId: number): TrackView[] =>
  useLibrary(s => appData().selectors.albumTracks(s, albumId));
export const usePlaylistTracks = (playlistId: number): PlaylistEntry[] =>
  useLibrary(s => appData().selectors.playlistTracks(s, playlistId));
export const useRecentlyPlayedAlbums = (limit: number): AlbumView[] =>
  useLibrary(s => appData().selectors.recentlyPlayedAlbums(s, limit));
export const useFavorites = (): TrackView[] => useLibrary(s => appData().selectors.favorites(s));
export const useSearchLocal = (query: string, limit: number): SearchResult =>
  useLibrary(s => appData().selectors.searchLocal(s, query, limit));

/** Эфемерные live-данные (прогресс поиска и буферизации). */
export const useLive = <T>(select: (s: LiveState) => T): T => useStore(appData().live, select);
