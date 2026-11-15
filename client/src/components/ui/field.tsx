import { createContext, useContext, useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type FieldContext = { id: string; describedBy?: string; invalid: boolean };

const Ctx = createContext<FieldContext | null>(null);

/** Атрибуты элемента управления внутри `Field`/`SettingsRow`: `id`, связь с описанием и ошибкой. Вне поля — пусто. */
export function useFieldControl(): { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true } {
  const ctx = useContext(Ctx);
  if (!ctx) return {};
  return { 'aria-describedby': ctx.describedBy, 'aria-invalid': ctx.invalid || undefined, id: ctx.id };
}

type FieldIds = { id: string; descriptionId: string; errorId: string; describedBy?: string };

/** Идентификаторы поля и значение `aria-describedby` (описание + ошибка, если они есть). */
export function useFieldIds(hasDescription: boolean, hasError: boolean): FieldIds {
  const base = useId();
  const descriptionId = `${base}-d`;
  const errorId = `${base}-e`;
  const describedBy = [hasDescription ? descriptionId : null, hasError ? errorId : null].filter(Boolean).join(' ');
  return { describedBy: describedBy || undefined, descriptionId, errorId, id: base };
}

export function FieldProvider({ children, ids, invalid }: { children: ReactNode; ids: FieldIds; invalid: boolean }) {
  return <Ctx.Provider value={{ describedBy: ids.describedBy, id: ids.id, invalid }}>{children}</Ctx.Provider>;
}

type Props = {
  label: string;
  description?: string;
  /** Текст ошибки: делает поле невалидным и связывается с ним через `aria-describedby`. */
  error?: string | null;
  children: ReactNode;
  className?: string;
};

/** Подпись + описание + ошибка вокруг одного элемента управления. */
export function Field({ label, description, error, children, className }: Props) {
  const ids = useFieldIds(Boolean(description), Boolean(error));
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label className="text-sm font-medium" htmlFor={ids.id}>
        {label}
      </label>
      <FieldProvider ids={ids} invalid={Boolean(error)}>
        {children}
      </FieldProvider>
      {description ? (
        <p className="text-muted text-xs" id={ids.descriptionId}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p className="text-danger-fg text-xs" id={ids.errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
