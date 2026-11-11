'use client';

import { useConnectionState } from '@/hooks/use-live-events';
import { cn } from '@/lib/utils';

const labels = {
  closed: 'Нет соединения с бэкендом',
  connecting: 'Подключение к бэкенду…',
  open: 'Соединение с бэкендом установлено',
} as const;

// Серая точка — нет соединения, зелёная — WebSocket подключён.
export function ConnectionIndicator({ showLabel = false }: { showLabel?: boolean }) {
  const state = useConnectionState();
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
      {showLabel ? <span>{state === 'open' ? 'Online' : 'Offline'}</span> : null}
    </span>
  );
}
