import type { Schemas } from '@/lib/api/client';
import { cn } from '@/lib/utils';

type Counts = Schemas['StatusCounts'];

const SEGMENTS: { key: keyof Counts; className: string; label: string }[] = [
  { className: 'bg-success', key: 'ready', label: 'скачано' },
  { className: 'bg-accent', key: 'found', label: 'найдено' },
  { className: 'bg-gray', key: 'adding', label: 'ищем' },
  { className: 'bg-danger/70', key: 'not_found', label: 'не найдено' },
];

export function statusSummary(counts: Counts) {
  return SEGMENTS.filter(s => counts[s.key] > 0)
    .map(s => `${counts[s.key]} ${s.label}`)
    .join(', ');
}

// Сегментированная полоска статусов треков альбома.
export function StatusMiniBar({ counts, total, className }: { counts: Counts; total: number; className?: string }) {
  if (total === 0) return null;
  return (
    <div
      role="img"
      aria-label={statusSummary(counts)}
      title={statusSummary(counts)}
      className={cn('bg-divider dark:bg-divider-dark flex h-1 w-full overflow-hidden rounded-full', className)}
    >
      {SEGMENTS.map(s =>
        counts[s.key] > 0 ? (
          <span key={s.key} className={s.className} style={{ width: `${(counts[s.key] / total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}
