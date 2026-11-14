import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/lib/i18n/provider';
import { useSettingsSave, type SaveStatus } from '@/lib/settings/hooks';
import type { ServerSettings } from '@/lib/settings/types';
import { SectionProvider } from './section-context';

const STATUS = { error: 'danger', idle: 'neutral', saved: 'success', saving: 'neutral' } as const;

/** Индикатор раздела: «Сохраняется… / Сохранено / Ошибка»; в покое пуст. */
export function SaveIndicator({ status }: { status: SaveStatus }) {
  const t = useT();
  return (
    <span aria-live="polite" data-testid="save-status" role="status">
      {status === 'idle' ? null : <Badge tone={STATUS[status]}>{t(`settings.status.${status}` as const)}</Badge>}
    </span>
  );
}

type Props = {
  id: string;
  title: string;
  description?: string;
  settings: ServerSettings;
  readOnly: boolean;
  children: ReactNode;
};

/** Раздел с серверными настройками: заголовок, индикатор сохранения, общая ошибка и контекст для строк. */
export function ServerSectionFrame({ id, title, description, settings, readOnly, children }: Props) {
  const { save, errors, status } = useSettingsSave();
  return (
    <SectionProvider value={{ errors, readOnly, save, settings, status }}>
      <div className="flex flex-col gap-4" data-testid={`settings-${id}`}>
        <PageHeader description={description} status={<SaveIndicator status={status} />} title={title} />
        {errors[''] ? (
          <p className="text-danger text-sm" role="alert">
            {errors['']}
          </p>
        ) : null}
        {children}
      </div>
    </SectionProvider>
  );
}

export function PageHeader({
  title,
  description,
  status,
}: {
  title: string;
  description?: string;
  status?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2>{title}</h2>
        {description ? <p className="text-muted mt-1 text-sm">{description}</p> : null}
      </div>
      {status}
    </header>
  );
}
