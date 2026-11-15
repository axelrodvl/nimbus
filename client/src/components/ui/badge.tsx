import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'success' | 'danger' | 'warning' | 'accent';

const tones: Record<Tone, string> = {
  accent: 'bg-accent/15 text-accent-fg',
  danger: 'bg-danger/15 text-danger-fg',
  neutral: 'bg-card text-muted dark:bg-card-dark',
  success: 'bg-success/15 text-success-fg',
  warning: 'bg-warning/15 text-warning-fg',
};

/** Небольшая метка состояния. Смысл передаётся текстом, цвет — только усиление. */
export function Badge({
  tone = 'neutral',
  children,
  className,
  ...rest
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  role?: 'status';
  'data-testid'?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
      {...rest}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}
