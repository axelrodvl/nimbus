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

/** Что пользователь попросил хранить на устройстве (шаг 46): трек, альбом или плейлист. Ключ — `"<kind>:<id>"`. */
export type OfflinePin = { key: string; kind: 'track' | 'album' | 'playlist'; id: number; created_at: number };

export type OfflineFileState = 'queued' | 'downloading' | 'done' | 'failed';

/** Файл трека на устройстве: состояние скачивания (сам файл лежит в `OfflineStorage`). */
export type OfflineFile = {
  track_id: number;
  state: OfflineFileState;
  bytes_done: number;
  bytes_total: number | null;
  mime: string;
  etag: string | null;
  /** Можно ли докачивать с места обрыва (сервер отдаёт `Accept-Ranges` и `ETag`). */
  resumable: boolean;
  attempts: number;
  error: string | null;
  next_attempt_at: number | null;
  completed_at: number | null;
};

export const emptyRows = (): LibraryRows => ({
  albums: [],
  artists: [],
  playlistTracks: [],
  playlists: [],
  tracks: [],
});
