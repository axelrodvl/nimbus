import { useStore } from 'zustand';
import { createAuthApi } from '@/lib/api/auth';
import { appData, resetAppData } from '@/lib/app-data';
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
    return appData().bootstrap();
  },
  onSignedOut: ({ clearData }) => {
    resetPlayer(clearData);
    // Выход стирает и кэш картинок (и, позже, офлайн-треки): обработчики из lib/pwa/logout.
    return Promise.all([resetAppData(clearData), clearData ? runLogoutHandlers() : undefined]).then(() => undefined);
  },
});

export function useSession<T>(select: (s: SessionState) => T): T {
  return useStore(session.store, select);
}
