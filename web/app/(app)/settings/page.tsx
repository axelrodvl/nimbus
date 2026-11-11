import { LanguageSelect } from '@/components/language-select';
import { AnimatedSuspense } from '@/components/ui/animated-suspense';
import { PageWrapper } from '@/components/ui/page-layout';
import { Skeleton } from '@/components/ui/skeleton';
import { LogoutButton } from '@/features/settings/components/logout-button';
import { SettingsPage } from '@/features/settings/components/settings-page';
import { getT } from '@/lib/i18n/server';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.settings') };
}

export default async function SettingsRoute() {
  const t = await getT();
  return (
    <PageWrapper title={t('nav.settings')}>
      <div className="mb-10 max-w-2xl">
        <LanguageSelect />
      </div>
      <AnimatedSuspense fallback={<Skeleton className="h-96 w-full max-w-2xl" />}>
        <SettingsPage />
      </AnimatedSuspense>
      <LogoutButton />
    </PageWrapper>
  );
}
