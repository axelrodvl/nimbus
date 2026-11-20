import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { createSession, safeNext, SESSION_KEY, SESSION_TIMEOUT_MS } from './session';

function setup(over: Partial<AuthApi> = {}, cached?: unknown) {
  const store = new Map<string, string>();
  if (cached !== undefined) store.set(SESSION_KEY, typeof cached === 'string' ? cached : JSON.stringify(cached));
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const api: AuthApi = {
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    session: vi.fn(async () => ({ auth_required: true, authenticated: true })),
    ...over,
  };
  const onAuthenticated = vi.fn(async () => undefined);
  const onSignedOut = vi.fn(async () => undefined);
  const session = createSession({ api, onAuthenticated, onSignedOut, storage });
  return { api, onAuthenticated, onSignedOut, session, store };
}

const net = () => new ApiError(0, 'network', 'down');

/** `session()`, который не отвечает, пока его не оборвут; запоминает сигналы. */
function hanging() {
  const signals: AbortSignal[] = [];
  const fn = vi.fn(
    (signal?: AbortSignal) =>
      new Promise<never>((_, reject) => {
        if (signal) signals.push(signal);
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
  return { fn, signals };
}

describe('сессия: сервер не отвечает', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('без кэша: через SESSION_TIMEOUT_MS → unreachable, запрос оборван', async () => {
    vi.useFakeTimers();
    const { fn, signals } = hanging();
    const { session } = setup({ session: fn });
    const started = session.start();
    await vi.advanceTimersByTimeAsync(SESSION_TIMEOUT_MS - 1);
    expect(session.store.getState()).toMatchObject({ status: 'unknown', unreachable: false });
    await vi.advanceTimersByTimeAsync(1);
    await started;
    expect(session.store.getState()).toMatchObject({ status: 'unknown', unreachable: true });
    expect(signals[0]?.aborted).toBe(true);
  });

  it('с кэшем: таймаут не трогает статус из кэша', async () => {
    vi.useFakeTimers();
    const { fn } = hanging();
    const { onAuthenticated, session } = setup({ session: fn }, { authRequired: true, status: 'authenticated' });
    const started = session.start();
    await vi.advanceTimersByTimeAsync(SESSION_TIMEOUT_MS);
    await started;
    expect(session.store.getState()).toMatchObject({ status: 'authenticated', unreachable: false });
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('api не слушает сигнал — таймаут всё равно срабатывает', async () => {
    vi.useFakeTimers();
    const { session } = setup({ session: () => new Promise<never>(() => undefined) });
    const started = session.start();
    await vi.advanceTimersByTimeAsync(SESSION_TIMEOUT_MS);
    await started;
    expect(session.store.getState().unreachable).toBe(true);
  });

  it('«Повторить» обрывает висящий запрос; итог — за новым, старый не ставит unreachable', async () => {
    vi.useFakeTimers();
    const { fn, signals } = hanging();
    const calls = vi
      .fn<(signal?: AbortSignal) => Promise<{ auth_required: boolean; authenticated: boolean }>>()
      .mockImplementationOnce(s => fn(s))
      .mockResolvedValue({ auth_required: true, authenticated: true });
    const { session } = setup({ session: calls });
    const first = session.start();
    const second = session.start();
    await Promise.all([first, second]);
    expect(signals[0]?.aborted).toBe(true);
    expect(session.store.getState()).toMatchObject({ status: 'authenticated', unreachable: false });
  });

  it('повтор после «недоступен» снова показывает заставку, пока ждёт ответа', async () => {
    vi.useFakeTimers();
    const { fn } = hanging();
    const { session } = setup({ session: fn });
    const first = session.start();
    await vi.advanceTimersByTimeAsync(SESSION_TIMEOUT_MS);
    await first;
    expect(session.store.getState().unreachable).toBe(true);
    const retry = session.start();
    expect(session.store.getState().unreachable).toBe(false);
    await vi.advanceTimersByTimeAsync(SESSION_TIMEOUT_MS);
    await retry;
    expect(session.store.getState().unreachable).toBe(true);
  });
});

describe('сессия: старт', () => {
  it('вошедший пользователь → authenticated, данные запускаются, результат кэшируется', async () => {
    const { onAuthenticated, session, store } = setup();
    expect(session.store.getState().status).toBe('unknown');
    await session.start();
    expect(session.store.getState()).toMatchObject({ authRequired: true, status: 'authenticated' });
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get(SESSION_KEY) ?? '')).toEqual({ authRequired: true, status: 'authenticated' });
  });

  it('авторизация выключена → authenticated без входа', async () => {
    const { session } = setup({ session: async () => ({ auth_required: false, authenticated: true }) });
    await session.start();
    expect(session.store.getState()).toMatchObject({ authRequired: false, status: 'authenticated' });
  });

  it('нужен вход → anonymous; данные не запускаются', async () => {
    const { onAuthenticated, session } = setup({
      session: async () => ({ auth_required: true, authenticated: false }),
    });
    await session.start();
    expect(session.store.getState().status).toBe('anonymous');
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('без сети и без кэша → unknown + unreachable; повторная попытка проходит', async () => {
    const calls = vi.fn().mockRejectedValueOnce(net()).mockResolvedValue({ auth_required: true, authenticated: true });
    const { session } = setup({ session: calls });
    await session.start();
    expect(session.store.getState()).toMatchObject({ status: 'unknown', unreachable: true });
    await session.start();
    expect(session.store.getState()).toMatchObject({ status: 'authenticated', unreachable: false });
  });

  it('без сети с кэшем authenticated → оболочка открывается сразу, данные запускаются один раз', async () => {
    const { onAuthenticated, session } = setup(
      { session: async () => Promise.reject(net()) },
      { authRequired: true, status: 'authenticated' },
    );
    await session.start();
    expect(session.store.getState().status).toBe('authenticated');
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('кэш authenticated, а сервер говорит «не вошёл» → anonymous и остановка без очистки данных', async () => {
    const { onSignedOut, session } = setup(
      { session: async () => ({ auth_required: true, authenticated: false }) },
      { authRequired: true, status: 'authenticated' },
    );
    await session.start();
    expect(session.store.getState().status).toBe('anonymous');
    expect(onSignedOut).toHaveBeenCalledWith({ clearData: false });
  });

  it('кэш anonymous применяется до ответа сервера; битый кэш игнорируется', async () => {
    let release = () => {};
    const gate = new Promise<void>(r => (release = r));
    const slow = setup(
      { session: async () => (await gate, { auth_required: true, authenticated: false }) },
      { authRequired: true, status: 'anonymous' },
    );
    const started = slow.session.start();
    expect(slow.session.store.getState().status).toBe('anonymous');
    release();
    await started;

    const broken = setup({}, '{не json');
    await broken.session.start();
    expect(broken.session.store.getState().status).toBe('authenticated');
    const wrong = setup({}, { status: 'weird' });
    await wrong.session.start();
    expect(wrong.session.store.getState().status).toBe('authenticated');
  });

  it('недоступное хранилище не мешает работе', async () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
      setItem: () => {
        throw new Error('denied');
      },
    };
    const session = createSession({
      api: {
        login: async () => undefined,
        logout: async () => undefined,
        session: async () => ({ auth_required: true, authenticated: true }),
      },
      onAuthenticated: () => undefined,
      onSignedOut: () => undefined,
      storage: broken,
    });
    await session.start();
    expect(session.store.getState().status).toBe('authenticated');
  });
});

describe('сессия: вход, выход, 401', () => {
  it('login: запрос → authenticated → данные запущены; кэш обновлён', async () => {
    const { api, onAuthenticated, session, store } = setup({
      session: async () => ({ auth_required: true, authenticated: false }),
    });
    await session.start();
    await session.login('secret');
    expect(api.login).toHaveBeenCalledWith('secret');
    expect(session.store.getState().status).toBe('authenticated');
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get(SESSION_KEY) ?? '').status).toBe('authenticated');
  });

  it('неверный токен: ошибка наружу, статус не меняется, данные не запускаются', async () => {
    const { onAuthenticated, session } = setup({
      login: async () => Promise.reject(new ApiError(401, 'unauthorized', 'no')),
      session: async () => ({ auth_required: true, authenticated: false }),
    });
    await session.start();
    await expect(session.login('bad')).rejects.toMatchObject({ status: 401 });
    expect(session.store.getState().status).toBe('anonymous');
    expect(onAuthenticated).not.toHaveBeenCalled();
    // 401 от самой формы входа не считается потерей сессии.
    await session.onUnauthorized();
    expect(session.store.getState().status).toBe('anonymous');
  });

  it('logout: запрос, остановка и очистка данных, loggedOut; при сбое сети всё равно выходит', async () => {
    const { api, onSignedOut, session } = setup();
    await session.start();
    await session.logout();
    expect(api.logout).toHaveBeenCalled();
    expect(onSignedOut).toHaveBeenCalledWith({ clearData: true });
    expect(session.store.getState()).toMatchObject({ loggedOut: true, status: 'anonymous' });

    const offline = setup({ logout: async () => Promise.reject(net()) });
    await offline.session.start();
    await offline.session.logout();
    expect(offline.session.store.getState().status).toBe('anonymous');
    expect(offline.onSignedOut).toHaveBeenCalledWith({ clearData: true });
  });

  it('401 посреди работы: anonymous, остановка без очистки; повторный вход запускает данные снова', async () => {
    const { onAuthenticated, onSignedOut, session } = setup();
    await session.start();
    await session.onUnauthorized();
    expect(session.store.getState()).toMatchObject({ loggedOut: false, status: 'anonymous' });
    expect(onSignedOut).toHaveBeenCalledWith({ clearData: false });
    await session.login('t');
    expect(onAuthenticated).toHaveBeenCalledTimes(2);
  });

  it('данные не запускаются дважды при повторных подтверждениях', async () => {
    const { onAuthenticated, session } = setup();
    await session.start();
    await session.login('t');
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });
});

describe('safeNext', () => {
  it('пропускает только внутренние пути', () => {
    expect(safeNext('/library?x=1')).toBe('/library?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('')).toBe('/');
  });
});
