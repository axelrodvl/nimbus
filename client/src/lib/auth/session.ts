import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AuthApi } from '@/lib/api/auth';

export type SessionStatus = 'unknown' | 'anonymous' | 'authenticated';

export type SessionState = {
  status: SessionStatus;
  /** На сервере включена авторизация (`NIMBUS_API_TOKEN`). */
  authRequired: boolean;
  /** Сервер не ответил, а в кэше ничего нет: оболочка предлагает повторить. */
  unreachable: boolean;
  /** Пользователь вышел сам: после выхода `/login` открывается без `next`. */
  loggedOut: boolean;
};

export type SessionStore = StoreApi<SessionState>;

export const SESSION_KEY = 'nimbus:session';

export type SessionDeps = {
  api: AuthApi;
  /** Вход подтверждён: запустить данные и live-соединение. */
  onAuthenticated: () => Promise<void> | void;
  /** Выход или потеря входа: остановить всё; `clearData` — ещё и стереть локальные данные. */
  onSignedOut: (opts: { clearData: boolean }) => Promise<void> | void;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
};

type Cached = { status: Exclude<SessionStatus, 'unknown'>; authRequired: boolean };

/** Путь возврата после входа: только внутренний (`/…`, но не `//host`). */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

export function createSession(deps: SessionDeps) {
  const storage = deps.storage === undefined ? safeLocalStorage() : deps.storage;
  const store: SessionStore = createStore<SessionState>(() => ({
    authRequired: true,
    loggedOut: false,
    status: 'unknown',
    unreachable: false,
  }));
  let active = false;

  function read(): Cached | null {
    try {
      const raw = storage?.getItem(SESSION_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as Partial<Cached>;
      if ((v.status === 'authenticated' || v.status === 'anonymous') && typeof v.authRequired === 'boolean') {
        return { authRequired: v.authRequired, status: v.status };
      }
    } catch {
      // Битый кэш — как будто его нет.
    }
    return null;
  }

  function write(value: Cached) {
    try {
      storage?.setItem(SESSION_KEY, JSON.stringify(value));
    } catch {
      // Кэш — удобство, не обязанность.
    }
  }

  async function enter() {
    if (active) return;
    active = true;
    await deps.onAuthenticated();
  }

  async function leave(clearData: boolean) {
    const was = active;
    active = false;
    if (was || clearData) await deps.onSignedOut({ clearData });
  }

  function set(status: Cached['status'], authRequired: boolean, loggedOut = false) {
    store.setState({ authRequired, loggedOut, status, unreachable: false });
    write({ authRequired, status });
  }

  return {
    /** Выход: сервер снимает cookie, локальные данные стираются. Сбой сети не мешает выйти локально. */
    async logout(): Promise<void> {
      try {
        await deps.api.logout();
      } catch {
        // Cookie истечёт сама; локально выходим в любом случае.
      }
      set('anonymous', store.getState().authRequired, true);
      await leave(true);
    },
    /** Вход по токену. Бросает `ApiError` (401 — неверный токен). */
    async login(token: string): Promise<void> {
      await deps.api.login(token);
      set('authenticated', true);
      await enter();
    },
    /** Потеря авторизации посреди работы (401): данные остаются, пользователь переходит на `/login?next=…`. */
    async onUnauthorized(): Promise<void> {
      // 401 на самой форме входа (неверный токен) — не потеря сессии.
      if (store.getState().status !== 'authenticated') return;
      set('anonymous', true);
      await leave(false);
    },
    /** Старт: берёт последнее известное состояние из кэша и сверяет его с сервером. */
    async start(): Promise<void> {
      const cached = read();
      if (cached) {
        store.setState({
          authRequired: cached.authRequired,
          loggedOut: false,
          status: cached.status,
          unreachable: false,
        });
        if (cached.status === 'authenticated') await enter();
      }
      try {
        const info = await deps.api.session();
        if (!info.auth_required || info.authenticated) {
          set('authenticated', info.auth_required);
          await enter();
        } else {
          set('anonymous', true);
          await leave(false);
        }
      } catch {
        // Нет сети (или сервер упал): остаёмся при кэше; без кэша — «не достучались».
        if (!cached) store.setState({ unreachable: true });
      }
    },
    store,
  };
}

export type Session = ReturnType<typeof createSession>;

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
