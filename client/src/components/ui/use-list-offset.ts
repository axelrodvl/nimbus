import { useLayoutEffect, useRef, useState } from 'react';
import { useScrollElement } from './scroll-container';

/**
 * Расстояние от начала прокручиваемого контейнера до списка (шапка экрана над ним) и ширина списка.
 * Обновляется при изменении размеров контента. Измеряется до первой отрисовки — позиция прокрутки
 * восстанавливается без прыжка.
 */
export function useListGeometry() {
  const scroll = useScrollElement();
  const ref = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ margin: 0, width: 0 });

  useLayoutEffect(() => {
    const list = ref.current;
    if (!scroll || !list) return;
    const measure = () => {
      const margin = Math.round(list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
      const width = Math.round(list.clientWidth || list.getBoundingClientRect().width);
      setGeometry(g => (g.margin === margin && g.width === width ? g : { margin, width }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const child of Array.from(scroll.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [scroll]);

  return { ...geometry, ref, scroll };
}
