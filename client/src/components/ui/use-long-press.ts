import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import { createLongPress } from '@/lib/gestures/long-press';
import { haptics } from '@/lib/platform/haptics';

/** Находит кнопку «…» внутри элемента и нажимает её: долгое нажатие открывает то же меню. */
export function openMenuOf(root: HTMLElement): boolean {
  const trigger = root.querySelector<HTMLElement>('[data-menu-trigger]');
  if (!trigger) return false;
  trigger.click();
  return true;
}

type Held = { press: ReturnType<typeof createLongPress>; root: HTMLElement | null };

/**
 * Долгое нажатие (500 мс, отмена при сдвиге > 10 px) на строке/карточке открывает меню «…» этого элемента.
 * Только для касаний (у мыши есть кнопка «…» и правая кнопка); системное меню и выделение подавлены.
 * Возвращает свойства для корневого элемента.
 */
export function useLongPress(open: (root: HTMLElement) => void = openMenuOf) {
  const openRef = useRef(open);
  const held = useRef<Held | null>(null);
  useEffect(() => {
    openRef.current = open;
  });
  // Машина состояний создаётся лениво, в обработчиках событий (не при рендере).
  const get = () => {
    if (!held.current) {
      const h: Held = {
        press: createLongPress({
          onTrigger: () => {
            if (!h.root) return;
            haptics().impact('tap');
            openRef.current(h.root);
          },
        }),
        root: null,
      };
      held.current = h;
    }
    return held.current;
  };
  useEffect(() => () => held.current?.press.cancel(), []);
  return {
    onClickCapture(e: MouseEvent<HTMLElement>) {
      // Отпускание пальца после долгого нажатия не должно открыть ссылку или запустить трек.
      if (get().press.consumeClick()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onContextMenu(e: MouseEvent<HTMLElement>) {
      // Android Chrome шлёт contextmenu на долгое касание: своё меню вместо системного.
      if (matchMedia('(pointer: coarse)').matches) e.preventDefault();
    },
    onPointerCancel: () => get().press.end(),
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.pointerType === 'mouse' || e.isPrimary === false) return;
      if ((e.target as Element).closest('button, a[data-no-long-press], input, [data-gesture="own"]')) return;
      const h = get();
      h.root = e.currentTarget;
      h.press.start(e.clientX, e.clientY);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => get().press.move(e.clientX, e.clientY),
    onPointerUp: () => get().press.end(),
    className: 'select-none [-webkit-touch-callout:none]',
  };
}
