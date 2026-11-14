import { cn } from '@/lib/utils';

type Props = {
  value: number;
  max: number;
  /** Окраска заполнения: `danger` — например, при превышении лимита. */
  tone?: 'accent' | 'warning' | 'danger';
  'aria-label': string;
  className?: string;
};

const tones = { accent: 'bg-accent', danger: 'bg-danger', warning: 'bg-warning' } as const;

/** Полоса прогресса/заполненности (`role="progressbar"`). */
export function ProgressBar({ value, max, tone = 'accent', className, ...rest }: Props) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      aria-valuemax={max}
      aria-valuemin={0}
      aria-valuenow={Math.min(value, max)}
      className={cn('bg-divider dark:bg-divider-dark h-2 w-full overflow-hidden rounded-full', className)}
      role="progressbar"
      {...rest}
    >
      <div className={cn('h-full rounded-full transition-[width]', tones[tone])} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}
