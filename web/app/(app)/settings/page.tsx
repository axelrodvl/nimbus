import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { Skeleton } from '@/components/ui/skeleton';
import { LogoutButton } from '@/features/settings/components/logout-button';
import { SettingsPage } from '@/features/settings/components/settings-page';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Настройки',
};

export default function SettingsRoute() {
  return (
    <PageWrapper title="Настройки">
      <AnimatedSuspense fallback={<Skeleton className="h-96 w-full max-w-2xl" />}>
        <SettingsPage />
      </AnimatedSuspense>
      <LogoutButton />
    </PageWrapper>
  );
}
