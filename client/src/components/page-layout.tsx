import type { ReactNode } from 'react';
import { MusicNote } from '@/components/ui/music-note';
import { useTitle } from '@/lib/nav/use-title';

type Props = {
  /** Заголовок `<h1>` экрана; без него экран рисует шапку сам. */
  title?: string;
  /** Заголовок вкладки браузера, если он отличается от `title` (экраны с собственной шапкой). */
  documentTitle?: string;
  /** Фирменный заголовок: акцентный цвет и значок, как в боковой панели. */
  brand?: boolean;
  children?: ReactNode;
};

/** Поля и заголовок экрана; прокручивается область контента оболочки, не сам экран. */
export function PageLayout({ title, documentTitle, brand, children }: Props) {
  useTitle(documentTitle ?? title);
  return (
    <div className="px-5 pt-3 pb-6">
      {title && brand ? (
        <h1 className="text-accent-fg mb-6 inline-flex items-center gap-2 text-3xl font-bold tracking-tight">
          <MusicNote className="text-accent-fg" size={32} />
          <span>{title}</span>
        </h1>
      ) : title ? (
        <h1 className="mb-6 text-3xl font-bold">{title}</h1>
      ) : null}
      {children}
    </div>
  );
}
