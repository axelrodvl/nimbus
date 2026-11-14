import { useConnectionState } from '@/lib/live/hooks';
import { useT } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

/** Серая точка — нет соединения, зелёная — WebSocket подключён. */
export function ConnectionIndicator({ showLabel = false }: { showLabel?: boolean }) {
  const state = useConnectionState();
  const t = useT();
  const labels = { closed: t('conn.closed'), connecting: t('conn.connecting'), open: t('conn.open') } as const;
  return (
    <span className="text-muted inline-flex items-center gap-2 text-xs" data-state={state} title={labels[state]}>
      <span
        aria-label={labels[state]}
        className={cn(
          'inline-block size-2 rounded-full',
          state === 'open' ? 'bg-success' : 'bg-gray/60',
          state === 'connecting' && 'animate-pulse',
        )}
        role="status"
      />
      {showLabel ? <span>{state === 'open' ? t('conn.online') : t('conn.offline')}</span> : null}
    </span>
  );
}
