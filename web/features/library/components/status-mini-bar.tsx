'use client';

import { STATUS_SEGMENTS, statusSummary } from '@/features/library/status-summary';
import type { Schemas } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { useT } from '@/providers/i18n-provider';

type Counts = Schemas['StatusCounts'];

// Сегментированная полоска статусов треков альбома.
export function StatusMiniBar({ counts, total, className }: { counts: Counts; total: number; className?: string }) {
  const t = useT();
  if (total === 0) return null;
  const summary = statusSummary(counts, t);
  return (
    <div
      role="img"
      aria-label={summary}
      title={summary}
      className={cn('bg-divider dark:bg-divider-dark flex h-1 w-full overflow-hidden rounded-full', className)}
    >
      {STATUS_SEGMENTS.map(s =>
        counts[s.key] > 0 ? (
          <span key={s.key} className={s.className} style={{ width: `${(counts[s.key] / total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}
