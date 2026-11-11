import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { BackendStatus, BackendStatusSkeleton } from '@/features/library/components/backend-status';
import { HomeContent } from '@/features/library/components/home-content';
import { AlbumGridSkeleton } from '@/features/library/components/library-cards';

export default function HomePage() {
  return (
    <PageWrapper title="Welcome back">
      <AnimatedSuspense fallback={<AlbumGridSkeleton />}>
        <HomeContent />
      </AnimatedSuspense>
      <div className="mt-10">
        <AnimatedSuspense fallback={<BackendStatusSkeleton />}>
          <BackendStatus />
        </AnimatedSuspense>
      </div>
    </PageWrapper>
  );
}
