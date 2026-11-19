import { PageLayout } from '@/components/page-layout';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

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

export function TrackListSkeleton({ count = 8, numbered = false }: { count?: number; numbered?: boolean }) {
  return (
    <div aria-busy className="flex flex-col gap-0.5">
      {Array.from({ length: count }).map((_, i) => (
        <div className={cn('flex items-center gap-3', numbered ? 'h-11 px-2' : 'h-[3.25rem] px-3')} key={i}>
          {numbered ? <Skeleton className="size-8 rounded-md" /> : <Skeleton className="size-10 rounded-md" />}
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-1/3" />
            {numbered ? null : <Skeleton className="h-3 w-1/4" />}
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
        <SectionHeadingSkeleton />
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

/** Заголовок раздела («Альбомы»): `h2` с `mb-4`. */
export function SectionHeadingSkeleton() {
  return <Skeleton className="mb-4 h-7 w-32" />;
}

/** Шапка артиста: аватар 160 px, подпись, имя, строка счётчиков и кнопка; на телефоне по центру, от `sm` — в ряд. */
export function ArtistHeaderSkeleton({ align = 'center' }: { align?: 'center' | 'end' }) {
  return (
    <div className={cn('mb-8 flex flex-col items-center gap-6 sm:flex-row', align === 'end' && 'sm:items-end')}>
      <Skeleton className="size-40 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-col items-center gap-3 sm:items-start">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-10 w-64 max-w-full" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-10 w-28 rounded-full" />
      </div>
    </div>
  );
}

/** Шапка альбома: обложка 192 px, подпись, название, строка с артистом и кнопки. */
export function AlbumHeaderSkeleton({ status = false }: { status?: boolean }) {
  return (
    <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
      <Skeleton className="size-48 shrink-0 self-center rounded-md sm:self-auto" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-10 w-64 max-w-full" />
        <Skeleton className="h-5 w-56 max-w-full" />
        {status ? <Skeleton className="h-2 w-full max-w-sm rounded-full" /> : null}
        <Skeleton className="h-10 w-36 rounded-full" />
      </div>
    </div>
  );
}

/** Экран артиста: шапка, заголовок «Альбомы» и сетка — как у готового экрана. */
export function ArtistSkeleton() {
  return (
    <div className="px-5 pt-[34px] pb-6 sm:pt-6" data-testid="screen-skeleton">
      <ArtistHeaderSkeleton />
      <SectionHeadingSkeleton />
      <AlbumGridSkeleton />
    </div>
  );
}

export function AlbumSkeleton() {
  return (
    <div className="px-5 pt-[34px] pb-6 sm:pt-6" data-testid="screen-skeleton">
      <AlbumHeaderSkeleton status />
      <TrackListSkeleton />
    </div>
  );
}
