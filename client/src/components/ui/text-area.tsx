import type { TextareaHTMLAttributes } from 'react';
import { useFieldControl } from '@/components/ui/field';
import { controlBase } from '@/components/ui/control';
import { cn } from '@/lib/utils';

/** Многострочное поле ввода; рамка и фокус — как у `TextInput`, высота растёт с `rows`. */
export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useFieldControl();
  return (
    <textarea
      className={cn(controlBase, 'h-auto rounded-2xl py-2 font-mono pointer-coarse:h-auto', className)}
      {...field}
      {...props}
    />
  );
}
