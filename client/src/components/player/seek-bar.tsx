import { cn } from '@/lib/utils';

type Props = {
  /** Текущее значение (секунды или проценты громкости). */
  value: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  disabled?: boolean;
  /** Диапазоны буфера (секунды) — светлая полоса под прогрессом. */
  buffered?: readonly (readonly [number, number])[];
  testId?: string;
  className?: string;
  /** `full` — толстая полоса полноэкранного плеера (под палец). */
  size?: 'bar' | 'full';
};

/** Полоса прогресса/громкости: нативный `input[type=range]` поверх нарисованной дорожки (доступность и жесты браузера). */
export function SeekBar({ value, max, onChange, label, disabled, buffered, testId, className, size = 'bar' }: Props) {
  const safeMax = max > 0 ? max : 1;
  const pct = Math.min(100, Math.max(0, (value / safeMax) * 100));
  const full = size === 'full';
  return (
    <div className={cn('group/slider relative flex flex-1 items-center', full && 'h-6', className)}>
      <div
        className={cn(
          'bg-divider dark:bg-divider-dark relative w-full rounded-full transition-all',
          full
            ? 'h-1.5 overflow-hidden bg-black/20 dark:bg-white/30'
            : 'h-0.5 group-focus-within/slider:h-1 group-hover/slider:h-1',
        )}
      >
        {buffered?.map(([s, e]) => (
          <div
            className={cn(
              'absolute top-0 h-full',
              full ? 'bg-black/25 dark:bg-white/40' : 'rounded-full bg-black/20 dark:bg-white/25',
            )}
            data-testid="player-buffered"
            key={`${s}-${e}`}
            style={{ left: `${(s / safeMax) * 100}%`, width: `${((e - s) / safeMax) * 100}%` }}
          />
        ))}
        <div
          className={cn(
            'absolute top-0 left-0 h-full rounded-full',
            full ? 'bg-black/80 dark:bg-white' : 'group-hover/slider:bg-accent bg-black/60 dark:bg-white/60',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <input
        aria-label={label}
        className={cn(
          'absolute inset-0 m-0 size-full appearance-none border-0 bg-transparent p-0 opacity-0',
          disabled ? 'pointer-events-none' : 'cursor-pointer',
        )}
        data-testid={testId}
        disabled={disabled}
        max={safeMax}
        min={0}
        onChange={e => onChange(Number(e.target.value))}
        step="any"
        type="range"
        value={Math.min(value, safeMax)}
      />
    </div>
  );
}
