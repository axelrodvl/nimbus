import { useT } from '@/lib/i18n/provider';
import { formatSize } from '@/lib/sources/format';
import { pinSubject, removeSubject, retryTracks, type OfflineSubject } from '@/lib/offline/actions';
import type { OfflineSummary } from '@/lib/offline/derive';
import { usePinned, useOfflineSupported } from '@/lib/offline/hooks';
import { OfflineButton } from './offline-button';

/** «Скачано N из M · X МБ»; размер — по факту (до скачивания он неизвестен). */
export function OfflineSummaryText({ summary, className }: { summary: OfflineSummary; className?: string }) {
  const t = useT();
  if (summary.state.kind === 'none' || summary.total === 0) return null;
  const text = t('offline.summary', { done: summary.done, total: summary.total });
  return (
    <span className={className} data-testid="offline-summary">
      {summary.bytes > 0 ? `${text} · ${formatSize(summary.bytes, t)}` : text}
    </span>
  );
}

/** Кнопка «на устройство» и сводка для альбома или плейлиста (шапка экрана). Не рисуется, если хранилища нет. */
export function OfflineControl({ subject, summary }: { subject: OfflineSubject; summary: OfflineSummary }) {
  const supported = useOfflineSupported();
  const pinned = usePinned(subject.kind, subject.id, subject.trackIds);
  if (!supported) return null;
  return (
    <div className="inline-flex items-center gap-3" data-testid="offline-control">
      <OfflineButton
        fraction={summary.total > 0 ? summary.done / summary.total : 0}
        onCancel={() => void removeSubject(subject)}
        onPin={() => void pinSubject(subject)}
        onRemove={() => void removeSubject(subject)}
        onRetry={() => retryTracks(subject.trackIds)}
        pinned={pinned}
        state={summary.state}
        title={subject.title}
        withLabel
      />
      <OfflineSummaryText className="text-muted text-xs" summary={summary} />
    </div>
  );
}
