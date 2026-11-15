import { useSyncExternalStore } from 'react';

/** Совпадает ли медиазапрос (подписка на изменения; без `matchMedia` — `false`). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    notify => {
      const mq = globalThis.matchMedia?.(query);
      mq?.addEventListener('change', notify);
      return () => mq?.removeEventListener('change', notify);
    },
    () => globalThis.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

/** Мобильная ширина (до `sm`): меню и диалоги выезжают нижним листом. */
export const useIsMobileWidth = (): boolean => useMediaQuery('(max-width: 639px)');
