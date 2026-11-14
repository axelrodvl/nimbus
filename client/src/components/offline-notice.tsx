import { WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n/provider';
import { useNetworkStatus } from '@/lib/live/hooks';
import { cn } from '@/lib/utils';

/**
 * Пояснение «нет сети / сервер недоступен» для частей экрана, которым нужен сервер.
 * Ничего не рисует, пока связь есть. `children` — собственный текст вместо общего.
 */
export function OfflineNotice({ children, className }: { children?: ReactNode; className?: string }) {
  const t = useT();
  const status = useNetworkStatus();
  if (status === 'online') return null;
  return (
    <p
      className={cn(
        'bg-card dark:bg-card-dark text-muted flex items-center gap-2 rounded-xl px-4 py-3 text-sm',
        className,
      )}
      data-status={status}
      data-testid="offline-notice"
      role="status"
    >
      <WifiOff aria-hidden className="size-4 shrink-0" />
      <span>{children ?? t(status === 'offline' ? 'offline.notice' : 'offline.serverNotice')}</span>
    </p>
  );
}
