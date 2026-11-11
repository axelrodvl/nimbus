import { PageWrapper } from '@/components/ui/page-layout';
import { EmptyLibrary } from '@/features/library/components/empty-library';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Library',
};

export default function LibraryPage() {
  return (
    <PageWrapper title="Library">
      <EmptyLibrary />
    </PageWrapper>
  );
}
