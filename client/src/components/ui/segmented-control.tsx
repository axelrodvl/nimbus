import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

export type SegmentOption<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
};

/** Выбор из 2–4 вариантов (`radiogroup`). Стрелки переносят выбор, как у обычных радиокнопок. */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  disabled,
  className,
  ...rest
}: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent, index: number) {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onValueChange(option.value);
    refs.current[next]?.focus();
  }

  return (
    <div
      className={cn(
        'border-divider dark:border-divider-dark inline-flex w-full rounded-full border p-0.5 sm:w-auto',
        className,
      )}
      role="radiogroup"
      {...rest}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            aria-checked={checked}
            className={cn(
              'focus-visible:ring-accent/40 h-9 flex-1 rounded-full px-4 text-sm font-medium transition-colors outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none pointer-coarse:h-10',
              checked ? 'bg-accent text-white' : 'text-muted hover:text-black dark:hover:text-white',
            )}
            disabled={disabled}
            key={o.value}
            onClick={() => onValueChange(o.value)}
            onKeyDown={e => onKeyDown(e, i)}
            ref={el => {
              refs.current[i] = el;
            }}
            role="radio"
            tabIndex={checked ? 0 : -1}
            type="button"
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
