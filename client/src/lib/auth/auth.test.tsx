import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appData, resetAppData } from '@/lib/app-data';
import { onLogout } from '@/lib/pwa/logout';
import { PERSIST_KEY } from '@/lib/pwa/storage';

vi.mock('@/lib/api/auth', () => ({
  createAuthApi: () => ({
    login: async () => undefined,
    logout: async () => undefined,
    session: async () => ({ auth_required: true, authenticated: true }),
  }),
}));

import { session, useSession } from './index';

afterEach(async () => {
  session.store.setState({ authRequired: true, loggedOut: false, status: 'unknown', unreachable: false });
  await resetAppData(true);
});

describe('сессия приложения', () => {
  it('useSession отражает состояние store', () => {
    function Probe() {
      return <p>{useSession(s => s.status)}</p>;
    }
    render(<Probe />);
    expect(screen.getByText('unknown')).toBeInTheDocument();
    act(() => session.store.setState({ status: 'authenticated' }));
    expect(screen.getByText('authenticated')).toBeInTheDocument();
  });

  it('вход запускает bootstrap данных, 401 после входа сбрасывает приложение без очистки базы', async () => {
    const bootstrap = vi.spyOn(appData(), 'bootstrap').mockResolvedValue();
    const first = appData();
    session.store.setState({ status: 'anonymous' });
    await session.login('t');
    expect(bootstrap).toHaveBeenCalledTimes(1);
    await session.onUnauthorized();
    expect(session.store.getState().status).toBe('anonymous');
    expect(appData()).not.toBe(first);
  });

  it('первый вход просит постоянное хранилище (один раз)', async () => {
    vi.spyOn(appData(), 'bootstrap').mockResolvedValue();
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { ...navigator, storage: { persist } });
    session.store.setState({ status: 'anonymous' });
    await session.login('t');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PERSIST_KEY)).toBe('1');
    await session.onUnauthorized();
    vi.spyOn(appData(), 'bootstrap').mockResolvedValue();
    await session.login('t');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('выход со стиранием данных вызывает обработчики onLogout; 401 — нет', async () => {
    vi.spyOn(appData(), 'bootstrap').mockResolvedValue();
    const handler = vi.fn();
    const off = onLogout(handler);
    session.store.setState({ status: 'anonymous' });
    await session.login('t');
    await session.onUnauthorized();
    expect(handler).not.toHaveBeenCalled();
    vi.spyOn(appData(), 'bootstrap').mockResolvedValue();
    await session.login('t');
    await session.logout();
    expect(handler).toHaveBeenCalledTimes(1);
    off();
  });
});
