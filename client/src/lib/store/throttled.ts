import type { StoreApi } from 'zustand/vanilla';

/**
 * Внешний источник для `useSyncExternalStore`: значение `select(state)` пересчитывается не чаще раза в `ms`
 * (первое изменение — сразу, остальные — одним отложенным пересчётом). Нужен спискам на десятки тысяч строк:
 * серия событий `track.status` не должна пересчитывать весь список на каждое событие (строки сами подписаны
 * на свои треки и обновляются мгновенно).
 */
export function createThrottledSource<S, T>(
  store: StoreApi<S>,
  select: (state: S) => T,
  ms: number,
  isEqual: (a: T, b: T) => boolean = Object.is,
) {
  let value: T | undefined;
  let has = false;
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  let off: (() => void) | null = null;

  function refresh() {
    timer = null;
    last = Date.now();
    const next = select(store.getState());
    if (has && isEqual(value as T, next)) return;
    value = next;
    has = true;
    for (const l of listeners) l();
  }

  function onChange() {
    if (timer) return;
    const wait = last + ms - Date.now();
    if (wait <= 0) refresh();
    else timer = setTimeout(refresh, wait);
  }

  return {
    getSnapshot(): T {
      if (!has) {
        value = select(store.getState());
        has = true;
        last = Date.now();
      }
      return value as T;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) off = store.subscribe(onChange);
      // Между созданием источника и подпиской данные могли измениться.
      onChange();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          off?.();
          off = null;
          if (timer) clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
}
