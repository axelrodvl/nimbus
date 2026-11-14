import { useEffect, useRef, useState } from 'react';
import { useFieldControl } from '@/components/ui/field';
import { cn } from '@/lib/utils';

type Props = {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Вызывается после паузы в движении ползунка (и при потере фокуса), а не на каждый шаг. */
  onCommit: (value: number) => void;
  debounceMs?: number;
  /** Как показывать значение (по умолчанию — число с точностью шага). */
  format?: (value: number) => string;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
};

/** Ползунок с отображением значения. Показывает значение сразу, наружу отдаёт одно итоговое — через `debounceMs`. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onCommit,
  debounceMs = 600,
  format,
  disabled,
  className,
  ...rest
}: Props) {
  const field = useFieldControl();
  const [local, setLocal] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  });

  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const v = pending.current;
    pending.current = null;
    setLocal(null);
    if (v !== null) commitRef.current(v);
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const shown = local ?? value;
  const digits = (String(step).split('.')[1] ?? '').length;
  return (
    <div className={cn('flex w-full items-center gap-3 sm:w-64', className)}>
      <input
        className="accent-accent focus-visible:ring-accent/40 h-10 min-w-0 flex-1 rounded-full outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11"
        disabled={disabled}
        max={max}
        min={min}
        onBlur={flush}
        onChange={e => {
          const v = Number(e.target.value);
          pending.current = v;
          setLocal(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(flush, debounceMs);
        }}
        step={step}
        type="range"
        value={shown}
        {...field}
        {...rest}
      />
      <output className="text-muted w-12 text-right text-sm tabular-nums">
        {format ? format(shown) : shown.toFixed(digits)}
      </output>
    </div>
  );
}
