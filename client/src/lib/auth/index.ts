import { useStore } from 'zustand';
import { createAuthApi } from '@/lib/api/auth';
import { appData, resetAppData } from '@/lib/app-data';
import { resetPlayer } from '@/lib/player';
import { createSession, type SessionState } from './session';

export { safeNext, SESSION_KEY } from './session';
export type { SessionState, SessionStatus } from './session';

/** Сессия приложения: вход подтверждён → `bootstrap()` данных и сокета; выход → остановка и очистка. */
export const session = createSession({
  api: createAuthApi(),
  onAuthenticated: () => appData().bootstrap(),
  onSignedOut: ({ clearData }) => {
    resetPlayer(clearData);
    return resetAppData(clearData);
  },
});

export function useSession<T>(select: (s: SessionState) => T): T {
  return useStore(session.store, select);
}
