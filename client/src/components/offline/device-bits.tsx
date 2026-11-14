import { useT } from '@/lib/i18n/provider';
import type { PinSummary } from '@/lib/offline/derive';
import { formatSize } from '@/lib/sources/format';

/** «Скачано N из M · X МБ» для закрепления в списке «На устройстве»; для ошибки и очереди — своя подпись. */
export function OfflineProgressText({ pin }: { pin: PinSummary }) {
  const t = useT();
  const parts: string[] = [];
  if (pin.missing) parts.push(t('offline.device.missingHint'));
  else {
    parts.push(t('offline.summary', { done: pin.done, total: pin.total }));
    if (pin.bytes > 0) parts.push(formatSize(pin.bytes, t));
    if (pin.state.kind === 'queued') parts.push(t('offline.short.queued'));
    if (pin.failed > 0) parts.push(t('offline.queue.failed', { count: pin.failed }));
  }
  return (
    <span className="text-muted truncate text-xs" data-testid="pin-meta">
      {parts.join(' · ')}
    </span>
  );
}
