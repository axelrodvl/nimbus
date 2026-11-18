import { removeFromLibraryRequest } from '@/lib/api/library';
import { appData } from '@/lib/app-data';
import type { Album, Artist, Track } from '@/lib/db/types';

/**
 * Убрать артиста или альбом из библиотеки. Оптимистично: строки помечаются `in_library: false` в store
 * (как делает сервер: сам объект и все его треки), затем `DELETE`; при ошибке строки возвращаются.
 * Бросает `ApiError` (без сети — `offline`, store не меняется).
 */
export function removeFromLibrary(type: 'artist' | 'album', id: number): Promise<void> {
  const { library, mutations } = appData();
  let before: { artists: Artist[]; albums: Album[]; tracks: Track[] } = { albums: [], artists: [], tracks: [] };
  const off = <R extends { in_library: boolean }>(rows: R[]): R[] => rows.map(r => ({ ...r, in_library: false }));

  return mutations.mutate({
    apply() {
      const s = library.getState();
      const artist = type === 'artist' ? s.artists.get(id) : undefined;
      const albums =
        type === 'artist'
          ? (s.albumsByArtist.get(id) ?? []).flatMap(a => s.albums.get(a) ?? [])
          : [s.albums.get(id)].filter((a): a is Album => !!a);
      const trackIds =
        type === 'artist'
          ? (s.tracksByArtist.get(id) ?? [])
          : (s.tracksByAlbum.get(id) ?? []);
      before = {
        albums: albums.filter(a => a.in_library),
        artists: artist?.in_library ? [artist] : [],
        tracks: trackIds.flatMap(t => s.tracks.get(t) ?? []).filter(t => t.in_library),
      };
      s.applyBatch({ albums: off(before.albums), artists: off(before.artists), tracks: off(before.tracks) });
    },
    request: () => removeFromLibraryRequest(type, id),
    rollback() {
      library.getState().applyBatch(before);
    },
  });
}
