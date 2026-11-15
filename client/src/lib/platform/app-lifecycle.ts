// Что делает приложение при уходе в фон и возврате (подписки на `lifecycle`). Зависимости передаются, чтобы
// модуль можно было проверить без браузера; в приложении их собирает `startAppLifecycle()` из `main.tsx`.
import { appData } from '@/lib/app-data';
import { offline } from '@/lib/offline';
import { player } from '@/lib/player';
import { lifecycle, type Lifecycle } from './lifecycle';

/** Дольше этого в фоне — соединение с сервером считаем «мёртвым» даже при состоянии `open` (iOS рвёт сокеты молча). */
export const STALE_SOCKET_MS = 30_000;

export type AppLifecycleDeps = {
  lifecycle: Lifecycle;
  /** Сокет: текущее состояние и немедленное переподключение (без паузы backoff). */
  socket: { isOpen(): boolean; reconnect(): void };
  /** Сверка плеера с фактическим звуком. */
  reconcilePlayer(): void;
  /** Синхронно записать состояние плеера и очереди офлайн-загрузок. */
  persistPlayer(): void;
  flushOffline(): void;
  now?: () => number;
};

/**
 * Возврат на передний план: сокет переподключается сразу, плеер сверяется с фактическим звуком (дельта синхронизации —
 * по тому же событию в движке синхронизации). Уход в фон (`pagehide`/`freeze`): состояние сохраняется немедленно.
 */
export function wireAppLifecycle(deps: AppLifecycleDeps): () => void {
  const now = deps.now ?? Date.now;
  let hiddenAt: number | null = null;
  const offs = [
    deps.lifecycle.on('background', () => {
      hiddenAt = now();
      deps.persistPlayer();
      deps.flushOffline();
    }),
    deps.lifecycle.on('foreground', () => {
      const away = hiddenAt === null ? 0 : now() - hiddenAt;
      hiddenAt = null;
      if (!deps.socket.isOpen() || away > STALE_SOCKET_MS) deps.socket.reconnect();
      deps.reconcilePlayer();
    }),
  ];
  return () => offs.forEach(off => off());
}

/* v8 ignore start -- привязка к синглтонам приложения; проверяется e2e (mobile.spec.ts) */
let stop: (() => void) | null = null;

export function startAppLifecycle(): void {
  if (stop) return;
  stop = wireAppLifecycle({
    flushOffline: () => void offline().manager?.flush(),
    lifecycle: lifecycle(),
    persistPlayer: () => player().persist(),
    reconcilePlayer: () => player().reconcile(),
    socket: {
      isOpen: () => appData().socket.state.getState().state === 'open',
      reconnect: () => appData().socket.reconnect(),
    },
  });
}
/* v8 ignore stop */
