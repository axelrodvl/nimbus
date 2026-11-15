import * as Ariakit from '@ariakit/react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SheetHandle, useSheetDrag } from './sheet-drag';
import { useIsMobileWidth } from './use-media-query';

const desktop =
  'border-divider dark:border-divider-dark z-[70] min-w-44 rounded-lg border bg-white p-1 text-black shadow-lg dark:bg-black dark:text-white';
// Ariakit кладёт меню в обёртку, которую позиционирует инлайн-стилями (position/top/left/transform): лист прижимаем
// к низу именно её (классы с `!` перебивают инлайн), а само меню остаётся обычным блоком внутри.
const sheetWrapper = '!fixed !inset-x-0 !top-auto !bottom-0 !left-0 z-[70] !w-full !max-w-none !transform-none';
// z-index у листа обязателен: Ariakit копирует его с самого меню на обёртку (инлайн), иначе лист оказывается под таб-баром и плеером.
const mobile =
  'border-divider dark:border-divider-dark relative z-[70] max-h-[80vh] w-full overflow-y-auto rounded-t-2xl border-t bg-white px-3 pt-0 pb-[max(1rem,env(safe-area-inset-bottom))] text-black shadow-2xl dark:bg-black dark:text-white';

/**
 * Меню действий: на мобильной ширине — нижний лист (модальный, с затемнением, закрывается перетаскиванием вниз;
 * фокус и клавиатура остаются от Ariakit), на широких экранах — обычное выпадающее меню у кнопки.
 * Использовать внутри `Ariakit.MenuProvider`.
 */
export function MenuSheet({ children, className }: { children: ReactNode; className?: string }) {
  const sheet = useIsMobileWidth();
  const store = Ariakit.useMenuContext();
  const drag = useSheetDrag(() => store?.hide(), sheet);
  return (
    <Ariakit.Menu
      backdrop={sheet ? <div className="fixed inset-0 z-[65] bg-black/50" /> : false}
      className={cn(sheet ? mobile : desktop, className)}
      data-sheet={sheet || undefined}
      gutter={4}
      modal={sheet}
      portal
      // Прокрутка у приложения внутри своих контейнеров; блокировка body (на iOS — position: fixed) сдвигала весь экран.
      preventBodyScroll={false}
      style={drag.style}
      wrapperProps={sheet ? { className: sheetWrapper } : undefined}
    >
      {sheet ? <SheetHandle {...drag.handleProps} className="-mx-3" /> : null}
      {children}
    </Ariakit.Menu>
  );
}
