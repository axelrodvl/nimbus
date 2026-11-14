import * as Ariakit from '@ariakit/react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
};

/** Флажок для наборов значений; подпись — часть элемента (кликабельна). */
export function Checkbox({ checked, onCheckedChange, label, disabled, className }: Props) {
  return (
    <label
      className={cn(
        'border-divider dark:border-divider-dark has-focus-visible:ring-accent/40 inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm has-focus-visible:ring-2 has-disabled:cursor-not-allowed has-disabled:opacity-50 pointer-coarse:h-11',
        checked ? 'bg-accent/10 border-accent/50' : 'text-muted',
        className,
      )}
    >
      <Ariakit.Checkbox
        checked={checked}
        className="sr-only"
        disabled={disabled}
        onChange={e => onCheckedChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={cn(
          'flex size-4 items-center justify-center rounded border',
          checked ? 'bg-accent border-accent text-white' : 'border-gray',
        )}
      >
        {checked ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      {label}
    </label>
  );
}
