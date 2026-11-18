import { useQuery } from '@tanstack/react-query';
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

function useCatalog<T>(key: readonly unknown[], fetch: (signal: AbortSignal) => Promise<T>, enabled: boolean) {
  const q = useQuery({
    enabled,
    gcTime: SEARCH_STALE_MS * 2,
    queryFn: ({ signal }) => fetch(signal),
    queryKey: key,
    retry: shouldRetry,
    retryDelay,
    staleTime: SEARCH_STALE_MS,
  });
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
  useCatalog(['catalog', 'artist', mbid], signal => fetchCatalogArtist(mbid, signal), enabled);

/** Альбом и треклист из MusicBrainz (`/search/album/:mbid`). */
export const useCatalogAlbum = (mbid: string, enabled = true): CatalogQuery<CatalogAlbumResponse> =>
  useCatalog(['catalog', 'album', mbid], signal => fetchCatalogAlbum(mbid, signal), enabled);

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
