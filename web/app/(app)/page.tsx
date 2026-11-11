import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { BackendStatus, BackendStatusSkeleton } from '@/features/library/components/backend-status';
import { HomeContent } from '@/features/library/components/home-content';
import { AlbumGridSkeleton } from '@/features/library/components/library-cards';
import { getT } from '@/lib/i18n/server';

export default async function HomePage() {
  const t = await getT();
  return (
    <PageWrapper title={t('page.home.title')}>
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
