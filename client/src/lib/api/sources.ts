import { api as defaultClient, type createApiClient, type Schemas } from './client';
import { unwrap } from './errors';

type Client = ReturnType<typeof createApiClient>;

export type AlbumTorrent = Schemas['AlbumTorrentDto'];
export type TrackSource = Schemas['TrackSourceDto'];
export type TorrentFile = Schemas['TorrentFileDto'];
export type RetryResult = Schemas['RetryResponse'];
/** Выбор источника: существующий (`source_id`) или файл раздачи (`torrent_id` + `file_index`). */
export type SourceChoice = { source_id: number } | { torrent_id: number; file_index: number };

/** `GET /api/albums/{id}/torrents`. */
export async function getAlbumTorrents(albumId: number, signal?: AbortSignal, client: Client = defaultClient) {
  return unwrap(await client.GET('/api/albums/{id}/torrents', { params: { path: { id: albumId } }, signal }));
}

/** `GET /api/tracks/{id}/sources`. */
export async function getTrackSources(trackId: number, signal?: AbortSignal, client: Client = defaultClient) {
  return unwrap(await client.GET('/api/tracks/{id}/sources', { params: { path: { id: trackId } }, signal }));
}

/** `GET /api/torrents/{id}/files`. */
export async function getTorrentFiles(torrentId: number, signal?: AbortSignal, client: Client = defaultClient) {
  return unwrap(await client.GET('/api/torrents/{id}/files', { params: { path: { id: torrentId } }, signal }));
}

/** `PUT /api/tracks/{id}/source`. */
export async function setTrackSourceRequest(trackId: number, choice: SourceChoice, client: Client = defaultClient) {
  return unwrap(await client.PUT('/api/tracks/{id}/source', { body: choice, params: { path: { id: trackId } } }));
}

/** `POST /api/tracks/{id}/sources/{source_id}/confirm`. */
export async function confirmSourceRequest(trackId: number, sourceId: number, client: Client = defaultClient) {
  return unwrap(
    await client.POST('/api/tracks/{id}/sources/{source_id}/confirm', {
      params: { path: { id: trackId, source_id: sourceId } },
    }),
  );
}

/** `POST /api/tracks/{id}/retry`. */
export async function retryTrackRequest(trackId: number, client: Client = defaultClient): Promise<RetryResult> {
  return unwrap(await client.POST('/api/tracks/{id}/retry', { params: { path: { id: trackId } } }));
}

/** `POST /api/albums/{id}/retry`. */
export async function retryAlbumRequest(albumId: number, client: Client = defaultClient): Promise<RetryResult> {
  return unwrap(await client.POST('/api/albums/{id}/retry', { params: { path: { id: albumId } } }));
}

/** `POST /api/albums/{id}/torrents`. */
export async function addMagnetRequest(albumId: number, magnet: string, client: Client = defaultClient) {
  return unwrap(
    await client.POST('/api/albums/{id}/torrents', { body: { magnet }, params: { path: { id: albumId } } }),
  );
}
