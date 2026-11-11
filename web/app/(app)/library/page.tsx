import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { AlbumGridSkeleton } from '@/features/library/components/library-cards';
import { LibraryContent, parseStatusFilter, parseTab } from '@/features/library/components/library-content';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Library',
};

export default function LibraryPage({ searchParams }: PageProps<'/library'>) {
  return (
    <PageWrapper title="Library">
      <AnimatedSuspense fallback={<AlbumGridSkeleton />}>
        {searchParams.then(sp => (
          <LibraryContent tab={parseTab(sp.tab)} status={parseStatusFilter(sp.status)} />
        ))}
      </AnimatedSuspense>
    </PageWrapper>
  );
}
