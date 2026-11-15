import { CheckCircle2, CircleDot, CircleSlash, Loader2 } from 'lucide-react';
import { useT } from '@/lib/i18n/provider';
import { describeStatus, type AlbumProgressInfo } from '@/lib/library/status';
import type { TrackStatus } from '@/lib/store/selectors';
import { cn } from '@/lib/utils';

type Props = {
  status: TrackStatus;
  reason: string | null;
  /** Прогресс поиска по альбому — показывается, пока трек в статусе `adding`. */
  progress?: AlbumProgressInfo;
  className?: string;
};

/** Статус трека: иконка и подсказка. */
export function TrackStatusBadge({ status, reason, progress, className }: Props) {
  const t = useT();
  const label = describeStatus(t, status, reason, status === 'adding' ? progress : undefined);
  return (
    <span
      aria-label={label}
      className={cn('inline-flex size-5 shrink-0 items-center justify-center', className)}
      data-status={status}
      role="img"
      title={label}
    >
      {status === 'adding' ? (
        <Loader2 aria-hidden className="text-gray size-4 animate-spin" />
      ) : status === 'found' ? (
        <CircleDot aria-hidden className="text-accent-fg size-4" />
      ) : status === 'not_found' ? (
        <CircleSlash aria-hidden className="text-danger-fg/70 size-4" />
      ) : (
        <CheckCircle2 aria-hidden className="text-success-fg size-4" />
      )}
    </span>
  );
}
