'use client';

import { CheckCircle2, CircleDot, CircleSlash, Loader2 } from 'lucide-react';
import type { TrackStatus } from '@/lib/api/events';
import { cn } from '@/lib/utils';
import { useAlbumProgress, useTrackStatus } from '@/providers/live-library-provider';

const NOT_FOUND_TEXT: Record<string, string> = {
  dead_torrents: 'Нет сидов',
  no_match: 'Трек не найден в раздачах',
  no_torrents: 'Раздачи не найдены',
};

type Props = {
  trackId: number;
  albumId: number;
  status: TrackStatus;
  reason: string | null;
  className?: string;
};

export function describeStatus(
  status: TrackStatus,
  reason: string | null,
  progress?: { stage: 'searching' | 'verifying'; done: number; total: number },
) {
  switch (status) {
    case 'adding':
      if (progress?.stage === 'verifying' && progress.total > 0) {
        return `Проверяем раздачи ${progress.done}/${progress.total}`;
      }
      return 'Ищем раздачи…';
    case 'found':
      return 'Найдено, можно слушать';
    case 'not_found':
      return (reason && NOT_FOUND_TEXT[reason]) || 'Не найдено';
    case 'ready':
      return 'Скачано';
  }
}

// Статус трека: иконка + tooltip. Live-обновления (`track.status`) подменяют серверное значение.
export function TrackStatusBadge({ trackId, albumId, status, reason, className }: Props) {
  const live = useTrackStatus(trackId, status, reason);
  const progress = useAlbumProgress(albumId);
  const label = describeStatus(live.status, live.reason, live.status === 'adding' ? progress : undefined);

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
