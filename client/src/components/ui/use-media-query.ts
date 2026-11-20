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

/** Ширина от `sm` (панель плеера вместо мини-плеера): тот же брейкпоинт, что у классов `sm:`. */
export const useIsWideWidth = (): boolean => useMediaQuery('(min-width: 640px)');

/** Мобильная ширина (до `sm`): меню и диалоги выезжают нижним листом. */
export const useIsMobileWidth = (): boolean => useMediaQuery('(max-width: 639px)');
