import { Link } from 'react-router';
import { PageLayout } from '@/components/page-layout';
import { useT } from '@/lib/i18n/provider';

export function NotFound() {
  const t = useT();
  return (
    <PageLayout title={t('notFound.title')}>
      <p className="text-gray mb-4 text-sm">{t('notFound.body')}</p>
      <Link className="text-accent underline" to="/">
        {t('notFound.home')}
      </Link>
    </PageLayout>
  );
}
