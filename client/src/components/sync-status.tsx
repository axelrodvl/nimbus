import { appData } from '@/lib/app-data';
import { useT } from '@/lib/i18n/provider';
import { useSyncStatus } from '@/lib/sync/hooks';
import { describeSync } from '@/lib/sync/describe';
import { cn } from '@/lib/utils';

const TONE = {
  busy: 'bg-accent animate-pulse',
  error: 'bg-danger',
  ok: 'bg-success',
  warn: 'bg-warning',
} as const;

/** Ненавязчивый статус синхронизации: «синхронизировано / синхронизация / нет связи / ошибка + Повторить». */
export function SyncStatus({ labelClassName }: { labelClassName?: string }) {
  const t = useT();
  const status = useSyncStatus();
  const view = describeSync(status);
  const text = t(view.label, { count: view.count ?? 0 });
  return (
    <span
      className="text-muted inline-flex items-center gap-2 text-xs"
      data-state={status.state}
      data-testid="sync-status"
    >
      <span
        aria-label={text}
        className={cn('inline-block size-2 shrink-0 rounded-full', TONE[view.tone])}
        role="status"
      />
      <span className={cn('truncate', labelClassName)}>{text}</span>
      {view.retry ? (
        <button
          className={cn(
            'text-accent-fg focus-visible:ring-accent/40 rounded underline focus-visible:ring-2 focus-visible:outline-none',
            labelClassName,
          )}
          onClick={() => appData().engine.requestSync('manual')}
          type="button"
        >
          {t('common.retry')}
        </button>
      ) : null}
    </span>
  );
}
