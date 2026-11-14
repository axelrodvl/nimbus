import { useStore } from 'zustand';
import { createAuthApi } from '@/lib/api/auth';
import { appData, resetAppData } from '@/lib/app-data';
import { startOffline, stopOffline } from '@/lib/offline';
import { resetPlayer } from '@/lib/player';
import { runLogoutHandlers } from '@/lib/pwa/logout';
import { requestPersistentStorage } from '@/lib/pwa/storage';
import { createSession, type SessionState } from './session';

export { safeNext, SESSION_KEY } from './session';
export type { SessionState, SessionStatus } from './session';

/** Сессия приложения: вход подтверждён → `bootstrap()` данных и сокета; выход → остановка и очистка. */
export const session = createSession({
  api: createAuthApi(),
  onAuthenticated: () => {
    // После первого успешного входа — постоянное хранилище (повторно не спрашивает).
    void requestPersistentStorage();
    // Офлайн-менеджер стартует после данных: сверка закреплений идёт по загруженной библиотеке.
    return appData()
      .bootstrap()
      .then(() => startOffline())
      .then(() => undefined);
  },
  onSignedOut: ({ clearData }) => {
    resetPlayer(clearData);
    // Без стирания данных менеджер просто останавливается; со стиранием — `clearOffline` (обработчик выхода) сам дожидается воркера.
    if (!clearData) stopOffline();
    // Выход стирает и кэш картинок и офлайн-треки: обработчики из lib/pwa/logout.
    return Promise.all([resetAppData(clearData), clearData ? runLogoutHandlers() : undefined]).then(() => undefined);
  },
});

export function useSession<T>(select: (s: SessionState) => T): T {
  return useStore(session.store, select);
}
