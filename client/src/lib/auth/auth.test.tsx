import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appData, resetAppData } from '@/lib/app-data';

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
});
