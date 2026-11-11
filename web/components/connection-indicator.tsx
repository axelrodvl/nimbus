'use client';

import { useConnectionState } from '@/hooks/use-live-events';
import { cn } from '@/lib/utils';
import { useT } from '@/providers/i18n-provider';

// Серая точка — нет соединения, зелёная — WebSocket подключён.
export function ConnectionIndicator({ showLabel = false }: { showLabel?: boolean }) {
  const state = useConnectionState();
  const t = useT();
  const labels = {
    closed: t('conn.closed'),
    connecting: t('conn.connecting'),
    open: t('conn.open'),
  } as const;
  return (
    <span className="text-muted inline-flex items-center gap-2 text-xs" title={labels[state]} data-state={state}>
      <span
        role="status"
        aria-label={labels[state]}
        className={cn(
          'inline-block h-2 w-2 rounded-full',
          state === 'open' ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-600',
          state === 'connecting' && 'animate-pulse',
        )}
      />
      {showLabel ? <span>{state === 'open' ? t('conn.online') : t('conn.offline')}</span> : null}
    </span>
  );
}
