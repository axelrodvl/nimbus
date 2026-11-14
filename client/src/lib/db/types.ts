import type { Schemas } from '@/lib/api/client';

export type Artist = Schemas['SyncArtist'];
export type Album = Schemas['SyncAlbum'];
export type Track = Schemas['SyncTrack'];
export type Playlist = Schemas['SyncPlaylist'];
export type PlaylistTrack = Schemas['SyncPlaylistTrack'];

/** Сущности, которые бэкенд синхронизирует (имена — как в `deleted[].entity`). */
export type Entity = 'artist' | 'album' | 'track' | 'playlist' | 'playlist_track';

export type LibraryRows = {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
  playlists: Playlist[];
  playlistTracks: PlaylistTrack[];
};

/** Служебные значения синхронизации: курсор дельты, версия формата, время последней успешной синхронизации (мс). */
export type Meta = { cursor?: string; schema?: number; syncedAt?: number };

export type LibraryData = LibraryRows & { meta: Meta };

export type Deleted = { entity: string; id: number };

/** Пачка изменений: upsert строк, удаления и (необязательно) новые значения `meta` — применяется атомарно. */
export type Batch = Partial<LibraryRows> & { deleted?: Deleted[]; meta?: Partial<Meta> };

/** Отложенный запрос «трек прослушан» (единственная мутация, переживающая отсутствие сети). */
export type OutboxItem = { id: number; trackId: number; at: number };

export const emptyRows = (): LibraryRows => ({
  albums: [],
  artists: [],
  playlistTracks: [],
  playlists: [],
  tracks: [],
});
