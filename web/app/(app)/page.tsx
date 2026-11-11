import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { BackendStatus, BackendStatusSkeleton } from '@/features/library/components/backend-status';
import { EmptyLibrary } from '@/features/library/components/empty-library';

export default function HomePage() {
  return (
    <PageWrapper title="Welcome back">
      <EmptyLibrary />
      <div className="mt-6">
        <AnimatedSuspense fallback={<BackendStatusSkeleton />}>
          <BackendStatus />
        </AnimatedSuspense>
      </div>
    </PageWrapper>
  );
}
