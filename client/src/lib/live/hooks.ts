import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { appData } from '@/lib/app-data';
import type { LiveEvent, SocketState } from './socket';

/** Подписка на live-событие WebSocket; обработчик может меняться между рендерами без переподписки. */
export function useLiveEvent<T extends LiveEvent = LiveEvent>(type: string, handler: (event: T) => void): void {
  const onEvent = useEffectEvent((event: LiveEvent) => handler(event as T));
  useEffect(() => appData().socket.subscribe(onEvent, type), [type]);
}

/** Состояние WebSocket-соединения. */
export function useConnectionState(): SocketState {
  return useStore(appData().socket.state, s => s.state);
}

const subscribeOnline = (cb: () => void) => {
  globalThis.addEventListener('online', cb);
  globalThis.addEventListener('offline', cb);
  return () => {
    globalThis.removeEventListener('online', cb);
    globalThis.removeEventListener('offline', cb);
  };
};

/** `navigator.onLine` с подпиской на события браузера. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => globalThis.navigator?.onLine !== false,
    () => true,
  );
}
