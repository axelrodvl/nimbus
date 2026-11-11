import type { Schemas } from '@/lib/api/client';
import type { TFn } from '@/providers/i18n-provider';

type Counts = Schemas['StatusCounts'];

export const STATUS_SEGMENTS = [
  { className: 'bg-success', key: 'ready', label: 'status.ready' },
  { className: 'bg-accent', key: 'found', label: 'status.found' },
  { className: 'bg-gray', key: 'adding', label: 'status.adding' },
  { className: 'bg-danger/70', key: 'not_found', label: 'status.notFound' },
] as const satisfies readonly { className: string; key: keyof Counts; label: Parameters<TFn>[0] }[];

export function statusSummary(counts: Counts, t: TFn) {
  return STATUS_SEGMENTS.filter(s => counts[s.key] > 0)
    .map(s => t(s.label, { count: counts[s.key] }))
    .join(', ');
}
