import { EmptyState } from '@/components/ui/empty-state';
import { PageWrapper } from '@/components/ui/page-layout';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Search',
};

export default function SearchPage() {
  return (
    <PageWrapper title="Search">
      <EmptyState title="Поиск скоро появится" body="Поиск по MusicBrainz будет добавлен на следующем шаге." />
    </PageWrapper>
  );
}
