'use client';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { useT } from '@/providers/i18n-provider';

// Бэкенд недоступен или вернул ошибку: аккуратное сообщение вместо падения страницы.
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  return (
    <ErrorState body={t('error.page.body')} title={t('error.page.title')}>
      <Button onClick={reset} size="sm" variant="secondary">
        {t('common.retry')}
      </Button>
    </ErrorState>
  );
}
