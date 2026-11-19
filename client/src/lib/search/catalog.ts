import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import {
  fetchCatalogAlbum,
  fetchCatalogArtist,
  type CatalogAlbumResponse,
  type CatalogArtistResponse,
} from '@/lib/api/catalog';
import { ApiError } from '@/lib/api/errors';
import type { AlbumResult } from '@/lib/api/search-types';
import { SEARCH_STALE_MS } from './query';
import { retryDelay, shouldRetry } from './use-remote-search';

/** Состояние экрана каталога: как у поиска — сбои MusicBrainz повторяются сами, ошибка только окончательная (4xx). */
export type CatalogQuery<T> = {
  data: T | undefined;
  /** MusicBrainz не ответил — запрос повторяется. */
  retrying: boolean;
  error: ApiError | null;
  retry: () => void;
};

function catalogOptions<T>(key: readonly unknown[], fetch: (signal: AbortSignal) => Promise<T>) {
  return queryOptions({
    gcTime: SEARCH_STALE_MS * 2,
    queryFn: ({ signal }) => fetch(signal),
    queryKey: key,
    retry: shouldRetry,
    retryDelay,
    staleTime: SEARCH_STALE_MS,
  });
}

const artistOptions = (mbid: string) =>
  catalogOptions(['catalog', 'artist', mbid], signal => fetchCatalogArtist(mbid, signal));
const albumOptions = (mbid: string) =>
  catalogOptions(['catalog', 'album', mbid], signal => fetchCatalogAlbum(mbid, signal));

function useCatalog<T>(options: ReturnType<typeof catalogOptions<T>>, enabled: boolean) {
  const q = useQuery({ ...options, enabled });
  const error = !q.error ? null : q.error instanceof ApiError ? q.error : new ApiError(0, 'network', String(q.error));
  return {
    data: q.data,
    error,
    retry: () => void q.refetch(),
    retrying: q.isFetching && q.failureCount > 0,
  } satisfies CatalogQuery<T>;
}

/** Артист и его альбомы из MusicBrainz (`/search/artist/:mbid`). */
export const useCatalogArtist = (mbid: string, enabled = true): CatalogQuery<CatalogArtistResponse> =>
  useCatalog(artistOptions(mbid), enabled);

/** Альбом и треклист из MusicBrainz (`/search/album/:mbid`). */
export const useCatalogAlbum = (mbid: string, enabled = true): CatalogQuery<CatalogAlbumResponse> =>
  useCatalog(albumOptions(mbid), enabled);

/**
 * Сколько переход на экран каталога ждёт ответа: роутер держит прежний экран, и если ответ успел (кэш бэкенда —
 * десятки миллисекунд), экран открывается сразу целиком, без вспышки skeleton. Дольше — экран со skeleton.
 */
export const CATALOG_NAV_WAIT_MS = 800;

/**
 * Загрузка экрана каталога до перехода (loader маршрута). Данные уже в кэше — не ждёт (свежесть проверит сам экран);
 * иначе запрос начинается сразу и переход ждёт его не дольше `waitMs`, дальше запрос идёт в фоне — экран его
 * подхватит. Без сети не ждёт: экран покажет «нет сети».
 */
export async function preloadCatalog(
  client: QueryClient,
  kind: 'artist' | 'album',
  mbid: string,
  waitMs = CATALOG_NAV_WAIT_MS,
): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const cached =
    kind === 'artist'
      ? client.getQueryData(artistOptions(mbid).queryKey)
      : client.getQueryData(albumOptions(mbid).queryKey);
  if (cached !== undefined) return;
  const loaded =
    kind === 'artist' ? client.prefetchQuery(artistOptions(mbid)) : client.prefetchQuery(albumOptions(mbid));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    loaded,
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
}

export type DiscographySection = 'albums' | 'eps' | 'live' | 'compilations' | 'other';

const ORDER: DiscographySection[] = ['albums', 'eps', 'live', 'compilations', 'other'];

function sectionOf(a: Pick<AlbumResult, 'primary_type' | 'secondary_types'>): DiscographySection {
  const secondary = a.secondary_types.map(s => s.toLowerCase());
  if (secondary.includes('live')) return 'live';
  if (secondary.includes('compilation')) return 'compilations';
  if (secondary.length > 0) return 'other';
  const primary = a.primary_type?.toLowerCase();
  if (primary === 'album') return 'albums';
  if (primary === 'ep') return 'eps';
  return 'other';
}

/** Дискография по разделам, как в музыкальных сервисах: студийные альбомы, EP, концертные, сборники, прочее. */
export function groupDiscography<T extends Pick<AlbumResult, 'primary_type' | 'secondary_types'>>(
  albums: readonly T[],
): { section: DiscographySection; albums: T[] }[] {
  const by = new Map<DiscographySection, T[]>();
  for (const a of albums) {
    const s = sectionOf(a);
    const list = by.get(s);
    if (list) list.push(a);
    else by.set(s, [a]);
  }
  return ORDER.flatMap(section => {
    const list = by.get(section);
    return list ? [{ albums: list, section }] : [];
  });
}
