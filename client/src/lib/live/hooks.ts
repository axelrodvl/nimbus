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

/** Связь: `online`; `offline` — нет сети в браузере; `server-down` — сеть есть, но сокет к серверу закрыт. */
export type NetworkStatus = 'online' | 'offline' | 'server-down';

export function networkStatus(browserOnline: boolean, socket: SocketState): NetworkStatus {
  if (!browserOnline) return 'offline';
  return socket === 'closed' ? 'server-down' : 'online';
}

/** Состояние связи: сеть браузера и доступность сервера (по live-сокету). */
export function useNetworkStatus(): NetworkStatus {
  const browserOnline = useSyncExternalStore(
    subscribeOnline,
    () => globalThis.navigator?.onLine !== false,
    () => true,
  );
  return networkStatus(browserOnline, useConnectionState());
}

/** Можно ли рассчитывать на сервер: сеть браузера есть **и** сервер доступен. */
export function useOnline(): boolean {
  return useNetworkStatus() === 'online';
}
