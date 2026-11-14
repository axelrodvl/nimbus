import { useState, type InputHTMLAttributes } from 'react';
import { controlBase } from '@/components/ui/control';
import { useFieldControl } from '@/components/ui/field';
import { cn } from '@/lib/utils';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'> & {
  value: number;
  /** Вызывается по `blur`/Enter и только если значение изменилось. */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Единица измерения справа внутри поля. */
  unit?: string;
};

const decimals = (step: number) => (String(step).split('.')[1] ?? '').length;

/** Нормализует введённое: не число → `null`, иначе в границы и к шагу. */
export function normalizeNumber(raw: string, { min, max, step }: { min?: number; max?: number; step?: number }) {
  const n = Number(raw.replace(',', '.'));
  if (raw.trim() === '' || !Number.isFinite(n)) return null;
  let v = n;
  if (step) v = Number((Math.round(v / step) * step).toFixed(decimals(step)));
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

/** Число с шагом, границами и единицей. Колёсико значение не меняет; нечисловой ввод откатывается. */
export function NumberInput({ value, onCommit, min, max, step = 1, unit, className, ...props }: Props) {
  const field = useFieldControl();
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft === null) return;
    const next = normalizeNumber(draft, { max, min, step });
    setDraft(null);
    if (next !== null && next !== value) onCommit(next);
  }

  return (
    <div className={cn('relative min-w-0', className)}>
      <input
        className={cn(controlBase, 'w-full', unit && 'pr-12')}
        inputMode="decimal"
        max={max}
        min={min}
        onBlur={commit}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
        }}
        onWheel={e => e.currentTarget.blur()}
        step={step}
        type="number"
        value={draft ?? String(value)}
        {...field}
        {...props}
      />
      {unit ? (
        <span className="text-muted pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-xs">{unit}</span>
      ) : null}
    </div>
  );
}
