import { useAcquisitionSummary } from '@/lib/acquisition/hooks';
import { attentionCount } from '@/lib/acquisition/model';
import { useT } from '@/lib/i18n/provider';

/** Число альбомов, требующих внимания, на значке «Загрузки»; сводка приходит запросом при старте и по событиям. */
export function DownloadsBadge() {
  const t = useT();
  const count = attentionCount(useAcquisitionSummary().data);
  if (count === 0) return null;
  return (
    <span
      aria-label={t('acq.badge', { count })}
      className="bg-danger absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold text-white"
      data-testid="nav-badge-downloads"
      role="status"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
