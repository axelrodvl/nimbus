import type { AudioPosition } from './audio/types';
import type { PlayerController } from './controller';

/** Как часто позиция читается по `requestAnimationFrame`: чаще незачем (буфер собирается заново на каждое чтение). */
export const PROGRESS_INTERVAL_MS = 100;

const same = (a: AudioPosition, b: AudioPosition) =>
  Math.abs(a.current - b.current) < 0.05 &&
  a.duration === b.duration &&
  a.buffered.length === b.buffered.length &&
  a.buffered.every(([s, e], i) => s === b.buffered[i][0] && e === b.buffered[i][1]);

/** Источник позиции контроллера: один на контроллер, чтобы при любом числе подписчиков работал один цикл rAF. */
const sources = new WeakMap<PlayerController, ProgressSource>();
export function progressSourceFor(ctl: PlayerController): ProgressSource {
  let source = sources.get(ctl);
  if (!source) {
    source = createProgressSource(ctl);
    sources.set(ctl, source);
  }
  return source;
}

export type ProgressSource = ReturnType<typeof createProgressSource>;

/**
 * Внешний источник позиции воспроизведения для `useSyncExternalStore`. Пока есть подписчики: при каждом изменении
 * состояния плеера позиция читается заново, а при играющем треке и видимой вкладке — ещё и по
 * `requestAnimationFrame`. Позиция не попадает в общий store: иначе панель перерисовывалась бы несколько раз в секунду.
 */
export function createProgressSource(ctl: PlayerController) {
  let snapshot = ctl.getPosition();
  const listeners = new Set<() => void>();
  let raf = 0;
  let detach: (() => void) | null = null;

  const refresh = (notify: boolean) => {
    const next = ctl.getPosition();
    if (same(snapshot, next)) return;
    snapshot = next;
    if (notify) listeners.forEach(l => l());
  };
  let lastRead = Number.NEGATIVE_INFINITY;
  const loop = () => {
    const now = Date.now();
    if (now - lastRead >= PROGRESS_INTERVAL_MS) {
      lastRead = now;
      refresh(true);
    }
    raf = requestAnimationFrame(loop);
  };
  const sync = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (ctl.state.isPlaying && document.visibilityState === 'visible') raf = requestAnimationFrame(loop);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        refresh(false);
        const offStore = ctl.store.subscribe(() => {
          refresh(true);
          sync();
        });
        document.addEventListener('visibilitychange', sync);
        sync();
        detach = () => {
          offStore();
          document.removeEventListener('visibilitychange', sync);
          cancelAnimationFrame(raf);
          raf = 0;
        };
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          detach?.();
          detach = null;
        }
      };
    },
  };
}
