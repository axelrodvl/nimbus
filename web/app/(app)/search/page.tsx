import { Suspense } from 'react';
import { PageWrapper } from '@/components/ui/page-layout';
import { SearchSkeleton } from '@/features/search/components/search-results';
import { SearchView } from '@/features/search/components/search-view';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Search',
};

export default function SearchPage() {
  return (
    <PageWrapper title="Search">
      {/* useSearchParams() требует Suspense при Cache Components */}
      <Suspense fallback={<SearchSkeleton />}>
        <SearchView />
      </Suspense>
    </PageWrapper>
  );
}
