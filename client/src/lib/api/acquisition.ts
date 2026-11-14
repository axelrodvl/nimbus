import { api as defaultClient, type createApiClient, type Schemas } from './client';
import { unwrap, unwrapEmpty } from './errors';

type Client = ReturnType<typeof createApiClient>;

export type AcquisitionItem = Schemas['AcquisitionItem'];
export type AcquisitionPage = Schemas['AcquisitionPage'];
export type AcquisitionState = Schemas['AcquisitionState'];
export type AcquisitionSummary = Schemas['AcquisitionSummary'];
export type AcquisitionDownload = Schemas['AcquisitionDownload'];
export type PinState = Schemas['PinState'];
export type EngineTorrent = Schemas['DownloadDto'];
export type DownloadsOverview = Schemas['DownloadsResponse'];
export type JobInfo = Schemas['JobDto'];
export type RetryAcquisitionBody = Schemas['RetryAcquisitionRequest'];

/** Размер страницы списка альбомов. */
export const ACQUISITION_PAGE = 100;

export type ListQuery = { states?: readonly AcquisitionState[]; albumIds?: readonly number[]; cursor?: string | null };

/** `GET /api/acquisition` (страница по курсору). */
export async function listAcquisition(
  q: ListQuery,
  signal?: AbortSignal,
  client: Client = defaultClient,
): Promise<AcquisitionPage> {
  return unwrap(
    await client.GET('/api/acquisition', {
      params: {
        query: {
          album_ids: q.albumIds?.length ? q.albumIds.join(',') : undefined,
          cursor: q.cursor ?? undefined,
          limit: ACQUISITION_PAGE,
          state: q.states?.length ? q.states.join(',') : undefined,
        },
      },
      signal,
    }),
  );
}

/** `GET /api/acquisition/summary`. */
export async function getAcquisitionSummary(signal?: AbortSignal, client: Client = defaultClient) {
  return unwrap(await client.GET('/api/acquisition/summary', { signal }));
}

/** `POST /api/acquisition/retry`: сколько альбомов поставлено на повтор. */
export async function retryAcquisitionRequest(body: RetryAcquisitionBody, client: Client = defaultClient) {
  return unwrap(await client.POST('/api/acquisition/retry', { body })).queued;
}

/** `GET /api/downloads`: торренты движка, очередь закреплений и флаг паузы. */
export async function getDownloads(signal?: AbortSignal, client: Client = defaultClient): Promise<DownloadsOverview> {
  return unwrap(await client.GET('/api/downloads', { signal }));
}

/** `GET /api/jobs?state=failed`. */
export async function getFailedJobs(signal?: AbortSignal, client: Client = defaultClient) {
  return unwrap(await client.GET('/api/jobs', { params: { query: { limit: 200, state: 'failed' } }, signal }));
}

/** `POST /api/jobs/{id}/retry`. */
export async function retryJobRequest(id: number, client: Client = defaultClient) {
  return unwrap(await client.POST('/api/jobs/{id}/retry', { params: { path: { id } } }));
}

/** `POST /api/albums/{id}/download`: закрепить альбом. */
export async function pinAlbumRequest(id: number, client: Client = defaultClient) {
  return unwrap(await client.POST('/api/albums/{id}/download', { params: { path: { id } } }));
}

/** `DELETE /api/albums/{id}/download`. */
export async function unpinAlbumRequest(id: number, deleteFiles: boolean, client: Client = defaultClient) {
  unwrapEmpty(
    await client.DELETE('/api/albums/{id}/download', {
      params: { path: { id }, query: { delete_files: deleteFiles } },
    }),
  );
}

/** `POST /api/tracks/{id}/download`. */
export async function pinTrackRequest(id: number, client: Client = defaultClient) {
  return unwrap(await client.POST('/api/tracks/{id}/download', { params: { path: { id } } }));
}

/** `DELETE /api/tracks/{id}/download`. */
export async function unpinTrackRequest(id: number, deleteFiles: boolean, client: Client = defaultClient) {
  unwrapEmpty(
    await client.DELETE('/api/tracks/{id}/download', {
      params: { path: { id }, query: { delete_files: deleteFiles } },
    }),
  );
}

/** `POST /api/downloads/pause-all` и `resume-all`: возвращают новое состояние паузы. */
export async function setPausedAll(paused: boolean, client: Client = defaultClient): Promise<boolean> {
  const res = paused ? await client.POST('/api/downloads/pause-all') : await client.POST('/api/downloads/resume-all');
  return unwrap(res).paused;
}

/** `POST /api/downloads/{info_hash}/pause|resume`. */
export async function setTorrentPaused(infoHash: string, paused: boolean, client: Client = defaultClient) {
  const params = { params: { path: { info_hash: infoHash } } };
  unwrapEmpty(
    paused
      ? await client.POST('/api/downloads/{info_hash}/pause', params)
      : await client.POST('/api/downloads/{info_hash}/resume', params),
  );
}
