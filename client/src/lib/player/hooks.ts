import { useMemo, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { appData } from '@/lib/app-data';
import type { AudioPosition } from './audio/types';
import type { PlayerController } from './controller';
import { currentTrack, type PlayerState } from './engine';
import { player } from './index';
import { createProgressSource } from './progress';

/** Срез состояния плеера; перерисовывается только при изменении выбранного значения. */
export function usePlayerState<T>(select: (s: PlayerState) => T): T {
  return useStore(player().store, select);
}

/** Действия плеера. Методы контроллера стабильны (стрелочные поля) — можно передавать в пропсы без `useCallback`. */
export function usePlayerActions(): PlayerController {
  return player();
}

/** Этот трек сейчас текущий в плеере (играет или на паузе). */
export const useIsCurrentTrack = (id: number): boolean => usePlayerState(s => currentTrack(s)?.id === id);

/** Этот трек сейчас играет. */
export const useIsTrackPlaying = (id: number): boolean =>
  usePlayerState(s => s.isPlaying && currentTrack(s)?.id === id);

/** Позиция воспроизведения (обновляется вне общего store — см. `createProgressSource`). */
export function useProgress(): AudioPosition {
  const ctl = player();
  const source = useMemo(() => createProgressSource(ctl), [ctl]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}

/**
 * Есть ли доступный трек после текущего. Зависит и от очереди, и от статусов треков в библиотеке (следующий трек
 * мог стать недоступным или быть удалён), поэтому подписан на оба store.
 */
export function useHasNext(): boolean {
  const ctl = player();
  const subscribe = useMemo(
    () => (notify: () => void) => {
      const offPlayer = ctl.store.subscribe(notify);
      const offLibrary = appData().library.subscribe(notify);
      return () => {
        offPlayer();
        offLibrary();
      };
    },
    [ctl],
  );
  return useSyncExternalStore(subscribe, () => ctl.hasNext());
}
