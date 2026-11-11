import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { Skeleton } from '@/components/ui/skeleton';
import { ArtistPage } from '@/features/library/components/artist-page';
import { AlbumGridSkeleton } from '@/features/library/components/library-cards';
import { getT } from '@/lib/i18n/server';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('meta.artist') };
}

export default function ArtistRoute({ params }: PageProps<'/artist/[id]'>) {
  return (
    <PageWrapper>
      <AnimatedSuspense
        fallback={
          <>
            <Skeleton className="mb-8 h-40 w-40 rounded-full" />
            <AlbumGridSkeleton />
          </>
        }
      >
        {params.then(({ id }) => (
          <ArtistPage id={id} />
        ))}
      </AnimatedSuspense>
    </PageWrapper>
  );
}
