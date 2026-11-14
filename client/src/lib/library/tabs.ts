import type { MessageKey } from '@/lib/i18n/messages';
import type { TrackStatus } from '@/lib/store/selectors';

/** Вкладки библиотеки — массивом, как пункты навигации. */
export const LIBRARY_TABS = [
  { id: 'albums', label: 'group.albums' },
  { id: 'artists', label: 'group.artists' },
  { id: 'tracks', label: 'group.tracks' },
  { id: 'playlists', label: 'group.playlists' },
] as const satisfies readonly { id: string; label: MessageKey }[];
export type LibraryTabId = (typeof LIBRARY_TABS)[number]['id'];
export const DEFAULT_TAB: LibraryTabId = 'albums';

export const STATUS_FILTERS = [
  { id: 'all', label: 'filter.all', statuses: undefined },
  { id: 'playable', label: 'filter.playable', statuses: ['found', 'ready'] },
  { id: 'adding', label: 'filter.adding', statuses: ['adding'] },
  { id: 'not_found', label: 'filter.notFound', statuses: ['not_found'] },
] as const satisfies readonly { id: string; label: MessageKey; statuses: readonly TrackStatus[] | undefined }[];
export type StatusFilterId = (typeof STATUS_FILTERS)[number]['id'];

export function parseTab(value: string | undefined): LibraryTabId {
  return LIBRARY_TABS.find(t => t.id === value)?.id ?? DEFAULT_TAB;
}

export function parseStatusFilter(value: string | null | undefined): StatusFilterId {
  return STATUS_FILTERS.find(s => s.id === value)?.id ?? 'all';
}

/** Адрес вкладки с фильтрами: состояние живёт в URL, «назад» возвращает то же. */
export function libraryHref(
  tab: LibraryTabId,
  { q, status, offline }: { q?: string; status?: StatusFilterId; offline?: boolean },
): string {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  if (q) params.set('q', q);
  if (offline) params.set('offline', '1');
  const query = params.toString();
  return `/library/${tab}${query ? `?${query}` : ''}`;
}
