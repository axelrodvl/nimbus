import type { MessageKey, TFn } from '@/lib/i18n/messages';
import type { StatusCounts, TrackStatus } from '@/lib/store/selectors';

export const STATUS_SEGMENTS = [
  { className: 'bg-success', key: 'ready', label: 'status.ready' },
  { className: 'bg-accent', key: 'found', label: 'status.found' },
  { className: 'bg-gray', key: 'adding', label: 'status.adding' },
  { className: 'bg-danger/70', key: 'not_found', label: 'status.notFound' },
] as const satisfies readonly { className: string; key: TrackStatus; label: MessageKey }[];

/** «3 скачано, 5 найдено, …» — только ненулевые статусы. */
export function statusSummary(counts: StatusCounts, t: TFn): string {
  return STATUS_SEGMENTS.filter(s => counts[s.key] > 0)
    .map(s => t(s.label, { count: counts[s.key] }))
    .join(', ');
}

export type AlbumProgressInfo = { stage: 'searching' | 'verifying'; done: number; total: number };

/** Подпись статуса трека (для подсказки и `aria-label`). */
export function describeStatus(
  t: TFn,
  status: TrackStatus,
  reason: string | null,
  progress?: AlbumProgressInfo,
): string {
  switch (status) {
    case 'adding':
      if (progress?.stage === 'verifying' && progress.total > 0) {
        return t('status.label.verifying', { done: progress.done, total: progress.total });
      }
      return t('status.label.adding');
    case 'found':
      return t('status.label.found');
    case 'not_found':
      if (reason === 'dead_torrents') return t('status.reason.dead_torrents');
      if (reason === 'no_match') return t('status.reason.no_match');
      if (reason === 'no_torrents') return t('status.reason.no_torrents');
      return t('status.label.notFound');
    case 'ready':
      return t('status.label.ready');
  }
}

/** Трек можно слушать. */
export const isPlayable = (status: TrackStatus): boolean => status === 'found' || status === 'ready';

const ALBUM_TYPES = {
  album: 'album.type.album',
  broadcast: 'album.type.broadcast',
  ep: 'album.type.ep',
  other: 'album.type.other',
  single: 'album.type.single',
} as const satisfies Record<string, MessageKey>;

/** Тип релиза из MusicBrainz («Album», «EP», …) на языке интерфейса; неизвестный тип показывается как есть. */
export function albumTypeLabel(type: string | null | undefined, t: TFn): string | null {
  if (!type) return null;
  const key = ALBUM_TYPES[type.trim().toLowerCase() as keyof typeof ALBUM_TYPES];
  return key ? t(key) : type;
}

export const albumMeta = (
  a: { artistName: string; year?: number | null; primary_type?: string | null },
  t: TFn,
): string =>
  [a.artistName, a.year ? String(a.year) : null, albumTypeLabel(a.primary_type, t)].filter(Boolean).join(' · ');
