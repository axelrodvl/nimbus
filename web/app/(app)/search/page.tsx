import { Suspense } from 'react';
import { PageWrapper } from '@/components/ui/page-layout';
import { SearchSkeleton } from '@/features/search/components/search-results';
import { SearchView } from '@/features/search/components/search-view';
import { getT } from '@/lib/i18n/server';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.search') };
}

export default async function SearchPage() {
  const t = await getT();
  return (
    <PageWrapper title={t('nav.search')}>
      {/* useSearchParams() требует Suspense при Cache Components */}
      <Suspense fallback={<SearchSkeleton />}>
        <SearchView />
      </Suspense>
    </PageWrapper>
  );
}
