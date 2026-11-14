import type { InputHTMLAttributes } from 'react';
import { useFieldControl } from '@/components/ui/field';
import { controlBase } from '@/components/ui/control';
import { cn } from '@/lib/utils';

/** Однострочное поле ввода. Внутри `Field`/`SettingsRow` имя и ошибка берутся из поля, иначе нужен `aria-label`. */
export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const field = useFieldControl();
  return <input className={cn(controlBase, className)} {...field} {...props} />;
}
