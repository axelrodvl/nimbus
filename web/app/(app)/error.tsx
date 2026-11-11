'use client';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';

// Бэкенд недоступен или вернул ошибку: аккуратное сообщение вместо падения страницы.
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      body="Не удалось получить данные. Проверьте, что бэкенд запущен (just backend), и попробуйте ещё раз."
      title="Что-то пошло не так"
    >
      <Button onClick={reset} size="sm" variant="secondary">
        Повторить
      </Button>
    </ErrorState>
  );
}
