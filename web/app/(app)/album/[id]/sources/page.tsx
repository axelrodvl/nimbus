import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { Skeleton } from '@/components/ui/skeleton';
import { SourcesPage } from '@/features/sources/components/sources-page';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Источники',
};

export default function AlbumSourcesRoute({ params }: PageProps<'/album/[id]/sources'>) {
  return (
    <PageWrapper>
      <AnimatedSuspense fallback={<Skeleton className="h-64 w-full" />}>
        {params.then(({ id }) => (
          <SourcesPage id={id} />
        ))}
      </AnimatedSuspense>
    </PageWrapper>
  );
}
