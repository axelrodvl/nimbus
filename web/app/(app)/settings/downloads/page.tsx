import Link from 'next/link';
import { PageWrapper } from '@/components/ui/page-layout';
import { DownloadsView } from '@/features/downloads/components/downloads-view';
import { getT } from '@/lib/i18n/server';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.downloads') };
}

export default async function DownloadsRoute() {
  const t = await getT();
  return (
    <PageWrapper title={t('settings.downloads')}>
      <Link href="/settings" className="text-muted hover:text-accent mb-6 inline-block text-sm">
        ← {t('downloads.back')}
      </Link>
      <DownloadsView />
    </PageWrapper>
  );
}
