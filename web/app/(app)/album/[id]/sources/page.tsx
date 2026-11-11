import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { Skeleton } from '@/components/ui/skeleton';
import { SourcesPage } from '@/features/sources/components/sources-page';
import { getT } from '@/lib/i18n/server';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('meta.sources') };
}

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
