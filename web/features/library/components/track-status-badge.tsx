'use client';

import { CheckCircle2, CircleDot, CircleSlash, Loader2 } from 'lucide-react';
import type { TrackStatus } from '@/lib/api/events';
import { cn } from '@/lib/utils';
import { useT, type TFn } from '@/providers/i18n-provider';
import { useAlbumProgress, useTrackStatus } from '@/providers/live-library-provider';

type Props = {
  trackId: number;
  albumId: number;
  status: TrackStatus;
  reason: string | null;
  className?: string;
};

export function describeStatus(
  t: TFn,
  status: TrackStatus,
  reason: string | null,
  progress?: { stage: 'searching' | 'verifying'; done: number; total: number },
) {
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

// Статус трека: иконка + tooltip. Live-обновления (`track.status`) подменяют серверное значение.
export function TrackStatusBadge({ trackId, albumId, status, reason, className }: Props) {
  const t = useT();
  const live = useTrackStatus(trackId, status, reason);
  const progress = useAlbumProgress(albumId);
  const label = describeStatus(t, live.status, live.reason, live.status === 'adding' ? progress : undefined);

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-status={live.status}
      className={cn('inline-flex h-5 w-5 shrink-0 items-center justify-center', className)}
    >
      {live.status === 'adding' ? (
        <Loader2 className="text-gray h-4 w-4 animate-spin" aria-hidden />
      ) : live.status === 'found' ? (
        <CircleDot className="text-accent h-4 w-4" aria-hidden />
      ) : live.status === 'not_found' ? (
        <CircleSlash className="text-danger/70 h-4 w-4" aria-hidden />
      ) : (
        <CheckCircle2 className="text-success h-4 w-4" aria-hidden />
      )}
    </span>
  );
}

export function isPlayable(status: TrackStatus) {
  return status === 'found' || status === 'ready';
}
