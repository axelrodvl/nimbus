import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { Skeleton } from '@/components/ui/skeleton';
import { AlbumPage } from '@/features/library/components/album-page';
import { TrackListSkeleton } from '@/features/track/components/track-row';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Album',
};

export default function AlbumRoute({ params }: PageProps<'/album/[id]'>) {
  return (
    <PageWrapper>
      <AnimatedSuspense
        fallback={
          <>
            <div className="mb-8 flex gap-6">
              <Skeleton className="h-48 w-48 rounded-md" />
              <div className="flex flex-col justify-end gap-3">
                <Skeleton className="h-10 w-64" />
                <Skeleton className="h-4 w-40" />
              </div>
            </div>
            <TrackListSkeleton count={8} showIndex />
          </>
        }
      >
        {params.then(({ id }) => (
          <AlbumPage id={id} />
        ))}
      </AnimatedSuspense>
    </PageWrapper>
  );
}
