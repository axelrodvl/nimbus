import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Однострочное поле ввода (скруглённое, с видимым фокусом). `aria-label` обязателен: подписи рядом нет. */
export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement> & { 'aria-label': string }) {
  return (
    <input
      className={cn(
        'border-divider dark:border-divider-dark focus-visible:ring-accent/40 min-w-0 rounded-full border bg-transparent px-4 py-2 text-sm outline-none focus-visible:ring-2',
        className,
      )}
      {...props}
    />
  );
}
