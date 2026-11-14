import { api as defaultClient, type createApiClient, type Schemas } from './client';
import { unwrap } from './errors';

export type ChangesResponse = Schemas['ChangesResponse'];

/** Сетевой слой синхронизации (то, что нужно движку от бэкенда). */
export interface SyncApi {
  /** Тело снимка (`application/x-ndjson`) как поток байт. */
  snapshot(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  changes(cursor: string): Promise<ChangesResponse>;
}

export function createSyncApi(client: ReturnType<typeof createApiClient> = defaultClient): SyncApi {
  return {
    async changes(cursor) {
      return unwrap(await client.GET('/api/sync/changes', { params: { query: { cursor } } }));
    },
    async snapshot(signal) {
      const stream = unwrap(await client.GET('/api/sync/snapshot', { parseAs: 'stream', signal }));
      return stream as ReadableStream<Uint8Array>;
    },
  };
}
