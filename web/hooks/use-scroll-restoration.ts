'use client';

import { useEffect, useRef } from 'react';

// Позиции прокрутки по URL. Скроллится контейнер страницы, а не window, поэтому
// встроенное восстановление Next.js не срабатывает.
const positions = new Map<string, number>();
let poppedAt = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    poppedAt = Date.now();
  });
}

// Запоминает scrollTop контейнера и возвращает его при переходе «назад/вперёд».
// Контент может дорисоваться позже (стриминг), поэтому позицию применяем, пока страница не станет достаточно высокой.
export function useScrollRestoration<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const key = location.pathname + location.search;
    const target = Date.now() - poppedAt < 1000 ? (positions.get(key) ?? 0) : 0;
    let restoring = target > 0;

    const apply = () => {
      if (!restoring) return;
      el.scrollTop = target;
      if (el.scrollTop >= target - 1) restoring = false;
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    const stop = () => {
      restoring = false;
    };
    // Пользователь сам начал скроллить — больше не вмешиваемся.
    el.addEventListener('wheel', stop, { passive: true });
    el.addEventListener('touchstart', stop, { passive: true });
    const timer = setTimeout(stop, 3000);

    const onScroll = () => {
      if (!restoring) positions.set(key, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (!restoring) positions.set(key, el.scrollTop);
      clearTimeout(timer);
      observer.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', stop);
      el.removeEventListener('touchstart', stop);
    };
  }, []);

  return ref;
}
