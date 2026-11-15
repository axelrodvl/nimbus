import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { sheetOffset, sheetRelease, velocityOf } from '@/lib/gestures/sheet-drag';

/**
 * Перетаскивание нижнего листа за «ручку»: лист следует за пальцем (`translate` — отдельное CSS-свойство, оно не
 * конфликтует с `transform`, которым Ariakit позиционирует всплывающие окна); отпускание — закрыть или вернуть.
 */
export function useSheetDrag(onClose: () => void, enabled: boolean) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; t: number; lastY: number; lastT: number; height: number } | null>(null);
  const velocity = useRef(0);

  const handleProps = enabled
    ? {
        onPointerCancel: () => {
          start.current = null;
          setDragging(false);
          setOffset(0);
        },
        onPointerDown(e: PointerEvent<HTMLElement>) {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Синтетическое или уже завершённое касание — захват не нужен.
          }
          const height = e.currentTarget.parentElement?.getBoundingClientRect().height ?? 0;
          start.current = { height, lastT: e.timeStamp, lastY: e.clientY, t: e.timeStamp, y: e.clientY };
          velocity.current = 0;
          setDragging(true);
        },
        onPointerMove(e: PointerEvent<HTMLElement>) {
          const s = start.current;
          if (!s) return;
          velocity.current = velocityOf(s.lastY, s.lastT, e.clientY, e.timeStamp);
          s.lastY = e.clientY;
          s.lastT = e.timeStamp;
          setOffset(sheetOffset(e.clientY - s.y));
        },
        onPointerUp(e: PointerEvent<HTMLElement>) {
          const s = start.current;
          start.current = null;
          setDragging(false);
          if (!s) return;
          const dy = e.clientY - s.y;
          if (sheetRelease(dy, velocity.current, s.height) === 'close') onClose();
          setOffset(0);
        },
        style: { touchAction: 'none' } satisfies CSSProperties,
      }
    : {};

  const style: CSSProperties = enabled
    ? { transition: dragging ? 'none' : 'translate 200ms ease-out', translate: `0 ${offset}px` }
    : {};
  return { dragging, handleProps, style };
}

/** «Ручка» нижнего листа: область захвата для перетаскивания вниз (видна только на мобильной ширине). */
export function SheetHandle({
  className = '-mx-6 -mt-6',
  ...props
}: ReturnType<typeof useSheetDrag>['handleProps'] & { className?: string }) {
  return (
    <div
      {...props}
      aria-hidden
      className={`${className} flex shrink-0 cursor-grab justify-center py-3 sm:hidden`}
      data-gesture="own"
      data-testid="sheet-handle"
    >
      <span className="bg-divider dark:bg-divider-dark h-1.5 w-10 rounded-full" />
    </div>
  );
}
