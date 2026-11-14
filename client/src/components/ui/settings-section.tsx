import type { ReactNode } from 'react';
import { FieldProvider, useFieldIds } from '@/components/ui/field';
import { cn } from '@/lib/utils';

type SectionProps = {
  /** Без заголовка карточка нужна, когда он повторял бы заголовок страницы раздела. */
  title?: string;
  description?: string;
  /** Справа в шапке: индикатор сохранения и т. п. */
  status?: ReactNode;
  children: ReactNode;
  'data-testid'?: string;
};

/** Карточка раздела настроек: заголовок, описание и строки `SettingsRow`. */
export function SettingsSection({ title, description, status, children, ...rest }: SectionProps) {
  return (
    <section className="bg-card dark:bg-card-dark rounded-2xl p-4 sm:p-5" {...rest}>
      {title || description || status ? (
        <header className="mb-1 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <h3 className="text-base">{title}</h3> : null}
            {description ? <p className="text-muted mt-0.5 text-sm">{description}</p> : null}
          </div>
          {status}
        </header>
      ) : null}
      <div className="divide-divider dark:divide-divider-dark divide-y">{children}</div>
    </section>
  );
}

type RowProps = {
  label: string;
  description?: string;
  error?: string | null;
  /** Элемент управления: на узком экране уходит под текст. */
  children: ReactNode;
  /** Без привязки подписи к элементу (когда внутри несколько элементов). */
  group?: boolean;
  className?: string;
};

/** Строка «название + пояснение слева, элемент управления справа». Связывает подпись, описание и ошибку с элементом. */
export function SettingsRow({ label, description, error, children, group, className }: RowProps) {
  const ids = useFieldIds(Boolean(description), Boolean(error));
  return (
    <div
      className={cn('flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6', className)}
      role={group ? 'group' : undefined}
      aria-labelledby={group ? `${ids.id}-l` : undefined}
    >
      <div className="min-w-0 sm:max-w-[55%]">
        <label className="text-sm font-medium" htmlFor={group ? undefined : ids.id} id={`${ids.id}-l`}>
          {label}
        </label>
        {description ? (
          <p className="text-muted mt-0.5 text-xs" id={ids.descriptionId}>
            {description}
          </p>
        ) : null}
        {error ? (
          <p className="text-danger mt-1 text-xs" id={ids.errorId} role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 shrink-0 flex-col gap-2 sm:items-end">
        <FieldProvider ids={ids} invalid={Boolean(error)}>
          {children}
        </FieldProvider>
      </div>
    </div>
  );
}
