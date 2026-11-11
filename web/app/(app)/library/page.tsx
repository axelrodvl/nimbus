import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { AlbumGridSkeleton } from '@/features/library/components/library-cards';
import { LibraryContent, parseStatusFilter, parseTab } from '@/features/library/components/library-content';
import { getT } from '@/lib/i18n/server';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.library') };
}

export default async function LibraryPage({ searchParams }: PageProps<'/library'>) {
  const t = await getT();
  return (
    <PageWrapper title={t('nav.library')}>
      <AnimatedSuspense fallback={<AlbumGridSkeleton />}>
        {searchParams.then(sp => (
          <LibraryContent tab={parseTab(sp.tab)} status={parseStatusFilter(sp.status)} />
        ))}
      </AnimatedSuspense>
    </PageWrapper>
  );
}
