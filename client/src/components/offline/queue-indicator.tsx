import { ArrowDownToLine } from 'lucide-react';
import { Link } from 'react-router';
import { useT } from '@/lib/i18n/provider';
import { useOfflineSupported, useQueueProgress } from '@/lib/offline/hooks';
import { cn } from '@/lib/utils';
import { ProgressRing } from './ring';

export const DEVICE_TAB_HREF = '/downloads/device';

/**
 * Глобальный индикатор загрузок на устройство: кольцо с общим прогрессом, нажатие — вкладка «На устройстве».
 * Скрыт, когда очередь пуста. `strip` — полоска с подписью для мобильной раскладки.
 */
export function OfflineQueueIndicator({
  variant = 'ring',
  className,
}: {
  variant?: 'ring' | 'strip';
  className?: string;
}) {
  const t = useT();
  const supported = useOfflineSupported();
  const progress = useQueueProgress();
  if (!supported || progress === null) return null;
  const percent = Math.round(progress * 100);
  const label = t('offline.indicator.queue', { percent });
  const ring = (
    <ProgressRing progress={progress} size={variant === 'ring' ? 24 : 20}>
      <ArrowDownToLine aria-hidden className="text-accent-fg size-2.5" />
    </ProgressRing>
  );
  if (variant === 'strip') {
    return (
      <Link
        aria-label={label}
        className={cn(
          'border-divider/70 dark:border-divider-dark/70 text-muted flex items-center justify-center gap-2 border-t bg-white py-1.5 text-xs sm:hidden dark:bg-[#181818]',
          className,
        )}
        data-testid="offline-queue-strip"
        to={DEVICE_TAB_HREF}
      >
        {ring}
        <span>{label}</span>
      </Link>
    );
  }
  return (
    <Link
      aria-label={label}
      className={cn(
        'focus-visible:ring-accent/40 rounded-full focus-visible:ring-2 focus-visible:outline-none',
        className,
      )}
      data-testid="offline-queue-indicator"
      title={label}
      to={DEVICE_TAB_HREF}
    >
      {ring}
    </Link>
  );
}
