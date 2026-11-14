import type { ReactNode } from 'react';
import { useTitle } from '@/lib/nav/use-title';

type Props = {
  /** Заголовок `<h1>` экрана; без него экран рисует шапку сам. */
  title?: string;
  /** Заголовок вкладки браузера, если он отличается от `title` (экраны с собственной шапкой). */
  documentTitle?: string;
  children?: ReactNode;
};

/** Поля и заголовок экрана; прокручивается область контента оболочки, не сам экран. */
export function PageLayout({ title, documentTitle, children }: Props) {
  useTitle(documentTitle ?? title);
  return (
    <div className="px-6 py-6 sm:px-8">
      {title ? <h1 className="mb-6 text-3xl font-bold">{title}</h1> : null}
      {children}
    </div>
  );
}
