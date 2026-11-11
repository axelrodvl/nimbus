import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FastLink } from '@/components/ui/fast-link';
import { getT } from '@/lib/i18n/server';

export async function EmptyLibrary() {
  const t = await getT();
  return (
    <EmptyState title={t('library.empty.title')} body={t('library.empty.body')}>
      <FastLink href="/search">
        <Button variant="secondary">{t('library.empty.cta')}</Button>
      </FastLink>
    </EmptyState>
  );
}
