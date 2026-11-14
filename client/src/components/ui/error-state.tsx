import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n/provider';

type Props = {
  title?: string;
  body?: string;
  compact?: boolean;
  // Элемент повтора: кнопка, вызывающая `reset()` границы ошибок или повторный запрос.
  children?: ReactNode;
};

export function ErrorState({ body, children, compact, title }: Props) {
  const t = useT();
  title ??= t('common.somethingWrong');
  if (compact) {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 px-4 py-4 text-center">
        <AlertTriangle aria-hidden className="text-danger size-4" />
        <p className="text-gray text-xs">{title}</p>
        {body ? <p className="text-gray max-w-xs text-xs">{body}</p> : null}
        {children}
      </div>
    );
  }

  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-5 py-10 text-center">
      <AlertTriangle aria-hidden className="text-danger size-6" />
      <p className="text-sm font-medium text-black dark:text-white">{title}</p>
      {body ? <p className="text-gray max-w-xs text-sm">{body}</p> : null}
      {children}
    </div>
  );
}
