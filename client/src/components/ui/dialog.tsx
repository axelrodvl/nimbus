import * as Ariakit from '@ariakit/react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SheetHandle, useSheetDrag } from './sheet-drag';
import { useIsMobileWidth } from './use-media-query';

export type DialogProps = {
  store: Ariakit.DialogStore;
  title: string;
  description?: string;
  /** Ширина: `sm` — формы и выбор плейлиста, `lg` — источники трека. */
  size?: 'sm' | 'lg';
  /** `sheet` — на мобильных выезжает снизу панелью (на широких экранах — обычное окно). */
  variant?: 'dialog' | 'sheet';
  /** Длинное описание переносится на несколько строк (по умолчанию — одна обрезанная). */
  wrapDescription?: boolean;
  /** Запрет закрытия, пока идёт действие. */
  locked?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * Модальное окно. Содержимое монтируется заново при каждом открытии (`unmountOnHide`) — состояние форм сбрасывается
 * само. Слой выше полноэкранного плеера и его меню: окно можно открыть из меню плеера.
 */
export function Dialog({
  store,
  title,
  description,
  size = 'sm',
  variant = 'dialog',
  wrapDescription,
  locked,
  className,
  children,
}: DialogProps) {
  const sheet = variant === 'sheet';
  const mobile = useIsMobileWidth();
  const drag = useSheetDrag(() => store.hide(), sheet && mobile && !locked);
  return (
    <Ariakit.Dialog
      backdrop={<div className="fixed inset-0 z-[65] bg-black/60 backdrop-blur-sm" />}
      className={cn(
        'border-divider dark:border-divider-dark fixed z-[70] flex flex-col gap-3 overflow-y-auto border bg-white p-6 text-black shadow-2xl outline-none dark:bg-black dark:text-white',
        sheet
          ? 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-h-[80vh] sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:pb-6'
          : 'top-1/2 left-1/2 max-h-[80vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl',
        size === 'sm' ? 'sm:max-w-sm' : 'sm:max-w-xl',
        !sheet && (size === 'sm' ? 'max-w-sm' : 'max-w-xl'),
        className,
      )}
      hideOnEscape={!locked}
      hideOnInteractOutside={!locked}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      store={store}
      style={drag.style}
      unmountOnHide
    >
      {sheet && mobile && !locked ? <SheetHandle {...drag.handleProps} /> : null}
      <Ariakit.DialogHeading className="text-lg font-bold">{title}</Ariakit.DialogHeading>
      {description ? (
        <Ariakit.DialogDescription className={cn('text-muted -mt-2 text-sm', !wrapDescription && 'truncate')}>
          {description}
        </Ariakit.DialogDescription>
      ) : null}
      {children}
    </Ariakit.Dialog>
  );
}
