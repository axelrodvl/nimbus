import * as Ariakit from '@ariakit/react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  store: Ariakit.DialogStore;
  title: string;
  description?: string;
  /** Ширина: `sm` — формы и выбор плейлиста, `lg` — источники трека. */
  size?: 'sm' | 'lg';
  className?: string;
  children: ReactNode;
};

/**
 * Модальное окно. Содержимое монтируется заново при каждом открытии (`unmountOnHide`) — состояние форм сбрасывается
 * само. Слой выше полноэкранного плеера и его меню: окно можно открыть из меню плеера.
 */
export function Dialog({ store, title, description, size = 'sm', className, children }: Props) {
  return (
    <Ariakit.Dialog
      backdrop={<div className="fixed inset-0 z-[65] bg-black/60 backdrop-blur-sm" />}
      className={cn(
        'border-divider dark:border-divider-dark fixed top-1/2 left-1/2 z-[70] flex max-h-[80vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-2xl border bg-white p-6 text-black shadow-2xl outline-none dark:bg-black dark:text-white',
        size === 'sm' ? 'max-w-sm' : 'max-w-xl',
        className,
      )}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      store={store}
      unmountOnHide
    >
      <Ariakit.DialogHeading className="text-lg font-bold">{title}</Ariakit.DialogHeading>
      {description ? (
        <Ariakit.DialogDescription className="text-muted -mt-2 truncate text-sm">
          {description}
        </Ariakit.DialogDescription>
      ) : null}
      {children}
    </Ariakit.Dialog>
  );
}
