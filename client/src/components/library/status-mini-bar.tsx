import { useT } from '@/lib/i18n/provider';
import { STATUS_SEGMENTS, statusSummary } from '@/lib/library/status';
import type { StatusCounts } from '@/lib/store/selectors';
import { cn } from '@/lib/utils';

/** Сегментированная полоска статусов треков альбома. */
export function StatusMiniBar({ counts, total, className }: { counts: StatusCounts; total: number; className?: string }) {
  const t = useT();
  if (total === 0) return null;
  const summary = statusSummary(counts, t);
  return (
    <div
      aria-label={summary}
      className={cn('bg-divider dark:bg-divider-dark flex h-1 w-full overflow-hidden rounded-full', className)}
      role="img"
      title={summary}
    >
      {STATUS_SEGMENTS.map(s =>
        counts[s.key] > 0 ? (
          <span className={s.className} key={s.key} style={{ width: `${(counts[s.key] / total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}
