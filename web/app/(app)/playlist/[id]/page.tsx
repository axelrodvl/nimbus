import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { Skeleton } from '@/components/ui/skeleton';
import { PlaylistPage } from '@/features/playlists/components/playlist-page';
import { TrackListSkeleton } from '@/features/track/components/track-row';
import { getT } from '@/lib/i18n/server';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('meta.playlist') };
}

export default function PlaylistRoute({ params }: PageProps<'/playlist/[id]'>) {
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
            <TrackListSkeleton count={8} />
          </>
        }
      >
        {params.then(({ id }) => (
          <PlaylistPage id={id} />
        ))}
      </AnimatedSuspense>
    </PageWrapper>
  );
}
