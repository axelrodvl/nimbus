import { useDeferredValue } from 'react';
import type { DownloadedSets } from '@/lib/offline/derive';
import { useLibraryList, type ListKind, type ListOf } from '@/lib/store/hooks';
import { filterByName } from '@/lib/store/selectors';
import { STATUS_FILTERS, type StatusFilterId } from './tabs';

type Named = {
  albums: (a: ListOf['albums'][number]) => string;
  artists: (a: ListOf['artists'][number]) => string;
  tracks: (a: ListOf['tracks'][number]) => string;
};

const NAME: Named = { albums: a => a.title, artists: a => a.name, tracks: t => t.title };

/**
 * Конвейер вкладки библиотеки: статус → «только скачанные» → подстрока (с отложенным `q`).
 * `all` — список до фильтров по подстроке и скачанному (чтобы отличить «пусто» от «ничего не подходит»).
 */
export function useFilteredLibraryList<K extends ListKind>(
  kind: K,
  { q, status, downloaded }: { q: string; status: StatusFilterId; downloaded: DownloadedSets | null },
): { all: ListOf[K]; items: readonly ListOf[K][number][] } {
  const statuses = STATUS_FILTERS.find(s => s.id === status)?.statuses;
  const all = useLibraryList(kind, statuses);
  const deferred = useDeferredValue(q);
  const set = downloaded?.[kind];
  const base = (set ? (all as { id: number }[]).filter(x => set.has(x.id)) : all) as ListOf[K];
  const name = NAME[kind] as (v: ListOf[K][number]) => string;
  return { all, items: filterByName(base, deferred, name) };
}
