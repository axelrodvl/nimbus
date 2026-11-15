import { Link } from 'react-router';
import { PageLayout } from '@/components/page-layout';
import { EmptyState } from '@/components/ui/empty-state';
import { useT } from '@/lib/i18n/provider';
import { useHydrated } from '@/lib/store/hooks';

/** Экран «такой записи нет в библиотеке» (перенос `not-found.tsx` старого интерфейса). */
export function ItemNotFound() {
  const t = useT();
  return (
    <PageLayout title={t('notFound.item.title')}>
      <EmptyState body={t('notFound.item.body')} title={t('notFound.item.title')}>
        <Link className="text-accent-fg underline" to="/library">
          {t('notFound.item.toLibrary')}
        </Link>
      </EmptyState>
    </PageLayout>
  );
}

/** Разбор `:id` маршрута: целое положительное число или `null`. */
export function parseId(raw: string | undefined): number | null {
  const n = Number(raw);
  return raw !== undefined && /^\d+$/.test(raw) && Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type EntityState = 'loading' | 'missing' | 'ready';

/** До гидратации — skeleton, после — «не найдено» или экран. Навигация никогда не ждёт сеть. */
export function useEntityState(exists: boolean): EntityState {
  const hydrated = useHydrated();
  if (exists) return 'ready';
  return hydrated ? 'missing' : 'loading';
}
