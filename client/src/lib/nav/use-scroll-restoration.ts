import { useEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/** Сколько ждём, пока контент дорисуется до нужной высоты, прежде чем отпустить прокрутку. */
export const RESTORE_TIMEOUT_MS = 3000;

/**
 * Позиции прокрутки по ключу записи истории (`location.key`): «назад/вперёд» возвращает позицию,
 * новый переход начинает сверху. Скроллится контейнер, а не `window`, поэтому встроенного
 * восстановления браузера недостаточно. Контент может дорисоваться позже — позиция применяется,
 * пока страница не станет достаточно высокой.
 */
export function useScrollRestoration(ref: RefObject<HTMLElement | null>): void {
  const { key } = useLocation();
  const type = useNavigationType();
  const positions = useRef(new Map<string, number>());

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = type === 'POP' ? (positions.current.get(key) ?? 0) : 0;
    let restoring = target > 0;
    if (!restoring) el.scrollTop = 0;

    const apply = () => {
      if (!restoring) return;
      el.scrollTop = target;
      if (el.scrollTop >= target - 1) restoring = false;
    };
    apply();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    const stop = () => {
      restoring = false;
    };
    // Пользователь сам начал скроллить — больше не вмешиваемся.
    el.addEventListener('wheel', stop, { passive: true });
    el.addEventListener('touchstart', stop, { passive: true });
    const timer = setTimeout(stop, RESTORE_TIMEOUT_MS);
    // Контент усох (экран сменился, список отфильтрован): браузер подрезает `scrollTop` по новой высоте. Это не
    // прокрутка пользователя — её нельзя запоминать, иначе «назад» вернёт подрезанную позицию (гонка с очисткой эффекта).
    let lastHeight = el.scrollHeight;
    // Последнее событие scroll было подрезкой: до настоящей прокрутки позицию не обновляем.
    let clamped = false;
    const shrunk = () => el.scrollHeight < lastHeight - 1;
    const onScroll = () => {
      clamped = shrunk();
      lastHeight = el.scrollHeight;
      if (!restoring && !clamped) positions.current.set(key, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const memory = positions.current;
    return () => {
      if (!restoring && !clamped && !shrunk()) memory.set(key, el.scrollTop);
      clearTimeout(timer);
      observer?.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', stop);
      el.removeEventListener('touchstart', stop);
    };
  }, [key, type, ref]);
}
