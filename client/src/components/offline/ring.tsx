import { cn } from '@/lib/utils';

/** Кольцо прогресса: доля 0…1 (0 — только дорожка). Внутри — любой значок. */
export function ProgressRing({
  progress,
  size,
  className,
  children,
}: {
  progress: number;
  size: number;
  className?: string;
  children?: React.ReactNode;
}) {
  const stroke = Math.max(2, Math.round(size / 10));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.min(1, Math.max(0, progress));
  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      data-progress={Math.round(p * 100)}
      style={{ height: size, width: size }}
    >
      <svg
        aria-hidden
        className="absolute inset-0 -rotate-90"
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        width={size}
      >
        <circle
          className="stroke-divider dark:stroke-divider-dark"
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={r}
          strokeWidth={stroke}
        />
        <circle
          className="stroke-accent transition-[stroke-dashoffset]"
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
          strokeLinecap="round"
          strokeWidth={stroke}
        />
      </svg>
      {children}
    </span>
  );
}
