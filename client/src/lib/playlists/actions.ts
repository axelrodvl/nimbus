import {
  addPlaylistTrackRequest,
  createPlaylistRequest,
  deletePlaylistRequest,
  removePlaylistTrackRequest,
} from '@/lib/api/playlists';
import { appData } from '@/lib/app-data';
import type { Playlist, PlaylistTrack } from '@/lib/db/types';
import { TEMP_ID_BASE } from '@/lib/store/library';

/** Запросы плейлистов; в тестах подменяются. */
export type PlaylistRequests = {
  create: typeof createPlaylistRequest;
  delete: typeof deletePlaylistRequest;
  add: typeof addPlaylistTrackRequest;
  remove: typeof removePlaylistTrackRequest;
};

const defaults: PlaylistRequests = {
  add: addPlaylistTrackRequest,
  create: createPlaylistRequest,
  delete: deletePlaylistRequest,
  remove: removePlaylistTrackRequest,
};

let tempSeq = 0;

/** Строки `playlist_tracks` плейлиста (настоящие и временные) для данного трека. */
function rowsFor(playlistId: number, trackId: number): PlaylistTrack[] {
  const s = appData().library.getState();
  return (s.tracksByPlaylist.get(playlistId) ?? [])
    .map(id => s.playlistTracks.get(id))
    .filter((r): r is PlaylistTrack => r?.track_id === trackId);
}

/** Трек уже в плейлисте (по данным store). */
export const isInPlaylist = (playlistId: number, trackId: number): boolean => rowsFor(playlistId, trackId).length > 0;

/**
 * Создать плейлист. Локального id до ответа нет (временных id у плейлистов не вводим), поэтому store меняется
 * после ответа сервера. Возвращает id нового плейлиста. Бросает `ApiError` (без сети — `offline`).
 */
export function createPlaylist(name: string, requests: PlaylistRequests = defaults): Promise<number> {
  const { library, mutations } = appData();
  return mutations.mutate({
    apply: () => undefined,
    request: async () => {
      const created = await requests.create(name);
      const row: Playlist = {
        created_at: created.created_at,
        id: created.id,
        last_used_at: created.created_at,
        name: created.name,
      };
      library.getState().applyBatch({ playlists: [row] });
      return created.id;
    },
    rollback: () => undefined,
  });
}

/** Удалить плейлист вместе с составом (как каскад на сервере). Оптимистично, при ошибке всё возвращается. */
export function deletePlaylist(id: number, requests: PlaylistRequests = defaults): Promise<void> {
  const { library, mutations } = appData();
  let playlist: Playlist | undefined;
  let rows: PlaylistTrack[] = [];
  return mutations.mutate({
    apply() {
      const s = library.getState();
      playlist = s.playlists.get(id);
      rows = (s.tracksByPlaylist.get(id) ?? []).flatMap(r => s.playlistTracks.get(r) ?? []);
      s.applyBatch({
        deleted: [...rows.map(r => ({ entity: 'playlist_track', id: r.id })), { entity: 'playlist', id }],
      });
    },
    request: () => requests.delete(id),
    rollback() {
      library.getState().applyBatch({ playlistTracks: rows, playlists: playlist ? [playlist] : [] });
    },
  });
}

/**
 * Добавить трек в плейлист. Сервер повторное добавление не отвергает (`UNIQUE`) и отвечает 204 так же, как на
 * новое, поэтому «уже есть» определяется по store: тогда запроса нет и результат — `exists`.
 * Оптимистично: временная строка и `last_used_at` плейлиста; настоящую строку принесёт дельта.
 */
export async function addTrackToPlaylist(
  playlistId: number,
  trackId: number,
  requests: PlaylistRequests = defaults,
): Promise<'added' | 'exists'> {
  if (isInPlaylist(playlistId, trackId)) return 'exists';
  const { library, mutations } = appData();
  const now = new Date().toISOString();
  const temp: PlaylistTrack = {
    added_at: now,
    id: TEMP_ID_BASE + ++tempSeq,
    playlist_id: playlistId,
    track_id: trackId,
  };
  let before: Playlist | undefined;
  await mutations.mutate({
    apply() {
      const s = library.getState();
      before = s.playlists.get(playlistId);
      s.applyBatch({
        playlistTracks: [temp],
        playlists: before ? [{ ...before, last_used_at: now }] : [],
      });
    },
    request: () => requests.add(playlistId, trackId),
    rollback() {
      library.getState().applyBatch({
        deleted: [{ entity: 'playlist_track', id: temp.id }],
        playlists: before ? [before] : [],
      });
    },
  });
  return 'added';
}

/** Убрать трек из плейлиста. Оптимистично, при ошибке строки возвращаются. */
export function removeTrackFromPlaylist(
  playlistId: number,
  trackId: number,
  requests: PlaylistRequests = defaults,
): Promise<void> {
  const { library, mutations } = appData();
  let removed: PlaylistTrack[] = [];
  return mutations.mutate({
    apply() {
      removed = rowsFor(playlistId, trackId);
      library.getState().applyBatch({ deleted: removed.map(r => ({ entity: 'playlist_track', id: r.id })) });
    },
    request: () => requests.remove(playlistId, trackId),
    rollback() {
      library.getState().applyBatch({ playlistTracks: removed });
    },
  });
}
