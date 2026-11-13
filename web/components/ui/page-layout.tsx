'use client';

import { useScrollRestoration } from '@/hooks/use-scroll-restoration';
import type { ReactNode } from 'react';

export function PageWrapper({ title, children }: { title?: string; children?: ReactNode }) {
  const ref = useScrollRestoration<HTMLDivElement>();
  return (
    <div ref={ref} className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-6 py-6 sm:px-8">
      {title && <h1 className="mb-6 text-3xl font-bold">{title}</h1>}
      {children}
    </div>
  );
}
