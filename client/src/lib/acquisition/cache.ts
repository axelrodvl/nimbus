import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { AcquisitionItem, AcquisitionPage } from '@/lib/api/acquisition';
import { LIST_ROOT, MAX_REFETCH_PAGES } from './keys';

type Pages = InfiniteData<AcquisitionPage, string | null>;

/** Применяет `fn` к строке альбома во всех открытых списках. */
export function updateAlbumRow(qc: QueryClient, albumId: number, fn: (item: AcquisitionItem) => AcquisitionItem): void {
  qc.setQueriesData<Pages>({ queryKey: LIST_ROOT }, data => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map(page => {
      if (!page.items.some(i => i.album.id === albumId)) return page;
      changed = true;
      return { ...page, items: page.items.map(i => (i.album.id === albumId ? fn(i) : i)) };
    });
    return changed ? { ...data, pages } : data;
  });
}

/** Снимок кэша строк альбома для отката оптимистичного изменения. */
export function snapshotRows(qc: QueryClient) {
  return qc.getQueriesData<Pages>({ queryKey: LIST_ROOT });
}

export function restoreRows(qc: QueryClient, snapshot: ReturnType<typeof snapshotRows>): void {
  for (const [key, data] of snapshot) qc.setQueryData(key, data);
}

/**
 * Перед перезапросом списков оставляет только первые страницы: инвалидация бесконечного списка перезапрашивает
 * все загруженные страницы, а при длинном списке это дорого.
 */
export function trimLists(qc: QueryClient): void {
  qc.setQueriesData<Pages>({ queryKey: LIST_ROOT }, data =>
    data && data.pages.length > MAX_REFETCH_PAGES
      ? { pageParams: data.pageParams.slice(0, MAX_REFETCH_PAGES), pages: data.pages.slice(0, MAX_REFETCH_PAGES) }
      : data,
  );
}

/** Плоский список без повторов (страницы, перезапрошенные посреди прокрутки, могут пересекаться). */
export function flattenPages(data: Pages | undefined): AcquisitionItem[] {
  const seen = new Set<number>();
  const out: AcquisitionItem[] = [];
  for (const page of data?.pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.album.id)) continue;
      seen.add(item.album.id);
      out.push(item);
    }
  }
  return out;
}

/** Кэш состояний альбомов в `localStorage` до ревью S11 (состояние теперь в синхронизации) — удаляется при старте. */
export const LEGACY_ALBUM_STORE_KEY = 'nimbus.acquisition.albums';

export function dropLegacyAlbumStore(): void {
  try {
    localStorage.removeItem(LEGACY_ALBUM_STORE_KEY);
  } catch {
    /* хранилище недоступно — удалять нечего */
  }
}
