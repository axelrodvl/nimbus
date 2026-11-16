import { PageLayout } from '@/components/page-layout';
import { Skeleton } from '@/components/ui/skeleton';

const GRID = 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

export function AlbumGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div aria-busy className={GRID}>
      {Array.from({ length: count }).map((_, i) => (
        <div className="flex flex-col gap-3 p-3" key={i}>
          <Skeleton className="aspect-square w-full rounded-md" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function TrackListSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div aria-busy className="flex flex-col gap-0.5">
      {Array.from({ length: count }).map((_, i) => (
        <div className="flex h-[3.25rem] items-center gap-3 px-3" key={i}>
          <Skeleton className="size-10 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <PageLayout brand title="Nimbus">
      <div data-testid="screen-skeleton">
        <Skeleton className="mb-4 h-6 w-48" />
        <AlbumGridSkeleton />
      </div>
    </PageLayout>
  );
}

export function LibrarySkeleton() {
  return (
    <div data-testid="screen-skeleton">
      <div className="mb-6 flex gap-2">
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
      </div>
      <AlbumGridSkeleton />
    </div>
  );
}

export function ArtistSkeleton() {
  return (
    <div className="px-4 py-6" data-testid="screen-skeleton">
      <div className="mb-8 flex flex-col items-center gap-6 sm:flex-row">
        <Skeleton className="size-40 rounded-full" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <AlbumGridSkeleton />
    </div>
  );
}

export function AlbumSkeleton() {
  return (
    <div className="px-4 py-6" data-testid="screen-skeleton">
      <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <Skeleton className="size-48 self-center rounded-md sm:self-auto" />
        <div className="flex flex-col justify-end gap-3">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <TrackListSkeleton />
    </div>
  );
}
