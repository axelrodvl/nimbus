import { Eye, EyeOff } from 'lucide-react';
import { useState, type InputHTMLAttributes } from 'react';
import { controlBase } from '@/components/ui/control';
import { useFieldControl } from '@/components/ui/field';
import { useT } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Секрет уже сохранён на сервере: пустое поле показывает маску и означает «не менять». */
  secretSet?: boolean;
};

/** Поле пароля/секрета с кнопкой «показать». Маску сервера в `value` не кладём — только то, что ввёл пользователь. */
export function PasswordInput({ value, onValueChange, secretSet, className, placeholder, ...props }: Props) {
  const t = useT();
  const field = useFieldControl();
  const [shown, setShown] = useState(false);
  return (
    <div className={cn('relative min-w-0', className)}>
      <input
        autoComplete="off"
        className={cn(controlBase, 'w-full pr-11')}
        onChange={e => onValueChange(e.target.value)}
        placeholder={secretSet && value === '' ? '••••' : placeholder}
        type={shown ? 'text' : 'password'}
        value={value}
        {...field}
        {...props}
      />
      <button
        aria-label={shown ? t('form.hidePassword') : t('form.showPassword')}
        aria-pressed={shown}
        className="text-muted focus-visible:ring-accent/40 absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1.5 hover:text-black focus-visible:ring-2 focus-visible:outline-none dark:hover:text-white"
        onClick={() => setShown(s => !s)}
        type="button"
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  );
}
