import type { ButtonHTMLAttributes } from 'react';
import { useFieldControl } from '@/components/ui/field';
import { cn } from '@/lib/utils';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

/** Переключатель вкл/выкл (`role="switch"`). Высота зоны нажатия — 40 px (на касаниях 44), сама дорожка меньше. */
export function Switch({ checked, onCheckedChange, className, ...props }: Props) {
  const field = useFieldControl();
  return (
    <button
      aria-checked={checked}
      className={cn(
        'focus-visible:ring-accent/40 relative inline-flex h-10 w-14 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11',
        className,
      )}
      onClick={() => onCheckedChange(!checked)}
      role="switch"
      type="button"
      {...field}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'relative block h-6 w-11 rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-divider dark:bg-divider-dark',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 block size-5 rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-5',
          )}
        />
      </span>
    </button>
  );
}
