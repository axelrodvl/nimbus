import { api as defaultClient, type createApiClient, type Schemas } from './client';
import { unwrap } from './errors';
import type { Patch, ServerSettings } from '@/lib/settings/types';

type Client = ReturnType<typeof createApiClient>;

export type StorageInfo = Schemas['StorageDto'];
export type ProviderTestResult = Schemas['ProviderTestResponse'];
export type ProviderName = Schemas['ProviderName'];

/** `GET /api/settings`. Схема не описывает форму тела — приводим к `ServerSettings`. */
export async function fetchSettings(signal?: AbortSignal, client: Client = defaultClient): Promise<ServerSettings> {
  return unwrap(await client.GET('/api/settings', { signal })) as ServerSettings;
}

/** `PUT /api/settings` — частичный патч; возвращает сохранённые настройки (+ `restart_required`, `suggest_retry_missing`). */
export async function putSettings(patch: Patch, client: Client = defaultClient): Promise<ServerSettings> {
  // Тело описано как `Record<string, never>`, поэтому приведение типа неизбежно.
  return unwrap(await client.PUT('/api/settings', { body: patch as Record<string, never> })) as ServerSettings;
}

/** `GET /api/storage`. */
export async function fetchStorage(signal?: AbortSignal, client: Client = defaultClient): Promise<StorageInfo> {
  return unwrap(await client.GET('/api/storage', { signal }));
}

/** `POST /api/settings/providers/test`. */
export async function testProvider(provider: ProviderName, client: Client = defaultClient) {
  return unwrap(await client.POST('/api/settings/providers/test', { body: { provider } }));
}

/** `POST /api/settings/reimport-artists`: сколько артистов поставлено на повторный импорт. */
export async function reimportArtists(client: Client = defaultClient): Promise<number> {
  return unwrap(await client.POST('/api/settings/reimport-artists')).queued;
}

/** `POST /api/acquisition/retry { scope: "missing" }`. */
export async function retryMissing(client: Client = defaultClient): Promise<number> {
  return unwrap(await client.POST('/api/acquisition/retry', { body: { scope: 'missing' } })).queued;
}

/** `GET /api/health`: версия сервера. */
export async function fetchServerVersion(signal?: AbortSignal, client: Client = defaultClient): Promise<string> {
  const h = unwrap(await client.GET('/api/health', { signal })) as { version?: string };
  return h.version ?? '';
}

/**
 * Включена ли предзагрузка следующего трека сразу (`playback.prefetch_next`). Настройки не загрузились —
 * считаем включённой (значение по умолчанию на сервере).
 */
export async function loadPrefetchEnabled(
  client: ReturnType<typeof createApiClient> = defaultClient,
): Promise<boolean> {
  try {
    const settings = unwrap(await client.GET('/api/settings')) as { playback?: { prefetch_next?: boolean } };
    return settings.playback?.prefetch_next ?? true;
  } catch {
    return true;
  }
}
