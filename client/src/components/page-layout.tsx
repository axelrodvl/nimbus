import type { ReactNode } from 'react';
import { useTitle } from '@/lib/nav/use-title';

/** Поля и заголовок экрана; прокручивается область контента оболочки, не сам экран. */
export function PageLayout({ title, children }: { title?: string; children?: ReactNode }) {
  useTitle(title);
  return (
    <div className="px-6 py-6 sm:px-8">
      {title ? <h1 className="mb-6 text-3xl font-bold">{title}</h1> : null}
      {children}
    </div>
  );
}
