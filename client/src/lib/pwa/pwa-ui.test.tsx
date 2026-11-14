import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineIndicator } from '@/components/offline-indicator';
import { OfflineNotice } from '@/components/offline-notice';
import { appData, resetAppData } from '@/lib/app-data';
import { networkStatus, useNetworkStatus, useOnline } from '@/lib/live/hooks';
import ru from '@/lib/i18n/messages/ru';

const L = (key: keyof typeof ru) => String(ru[key]);
import { renderWithProviders } from '@/test/render';
import { AboutSection } from '@/screens/settings/local-sections';
import { resetInstallForTests, listenForInstall, type InstallPromptEvent } from './install';

const socket = (state: 'connecting' | 'open' | 'closed') => act(() => appData().socket.state.setState({ state }));
const browserOnline = (online: boolean) => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  act(() => void window.dispatchEvent(new Event(online ? 'online' : 'offline')));
};

afterEach(async () => {
  resetInstallForTests();
  await resetAppData(true);
});

describe('состояние связи', () => {
  it('networkStatus: нет сети важнее закрытого сокета; сокет connecting — не авария', () => {
    expect(networkStatus(false, 'open')).toBe('offline');
    expect(networkStatus(false, 'closed')).toBe('offline');
    expect(networkStatus(true, 'closed')).toBe('server-down');
    expect(networkStatus(true, 'connecting')).toBe('online');
    expect(networkStatus(true, 'open')).toBe('online');
  });

  it('useOnline/useNetworkStatus: сеть есть, нет сети, сервер недоступен при наличии сети', () => {
    function Probe() {
      return (
        <p data-testid="p">
          {useNetworkStatus()}:{String(useOnline())}
        </p>
      );
    }
    render(<Probe />);
    socket('open');
    expect(screen.getByTestId('p')).toHaveTextContent('online:true');
    browserOnline(false);
    expect(screen.getByTestId('p')).toHaveTextContent('offline:false');
    browserOnline(true);
    socket('closed');
    expect(screen.getByTestId('p')).toHaveTextContent('server-down:false');
    socket('open');
    expect(screen.getByTestId('p')).toHaveTextContent('online:true');
  });

  it('OfflineNotice: молчит при связи; «нет сети» и «Сервер недоступен» — разные тексты; свой текст заменяет общий', () => {
    renderWithProviders(<OfflineNotice />);
    socket('open');
    expect(screen.queryByTestId('offline-notice')).not.toBeInTheDocument();
    socket('closed');
    expect(screen.getByTestId('offline-notice')).toHaveTextContent(L('offline.serverNotice'));
    expect(screen.getByTestId('offline-notice')).toHaveAttribute('data-status', 'server-down');
    browserOnline(false);
    expect(screen.getByTestId('offline-notice')).toHaveTextContent(L('offline.notice'));
  });

  it('OfflineNotice со своим текстом', () => {
    renderWithProviders(<OfflineNotice>свой</OfflineNotice>);
    socket('closed');
    expect(screen.getByTestId('offline-notice')).toHaveTextContent('свой');
  });

  it('OfflineIndicator различает «нет сети» и «Сервер недоступен»', () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('x');
    renderWithProviders(<OfflineIndicator />);
    socket('closed');
    expect(error).toHaveBeenLastCalledWith(L('offline.serverToast'), expect.anything());
    browserOnline(false);
    expect(error).toHaveBeenLastCalledWith(L('offline.toast'), expect.anything());
  });
});

describe('«О приложении»: хранилище и установка', () => {
  it('строка «Локальные данные: N МБ, хранилище постоянное: да/нет»', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      storage: { estimate: async () => ({ quota: 1e9, usage: 12_340_000 }), persisted: async () => true },
    });
    renderWithProviders(<AboutSection />);
    const row = await screen.findByTestId('storage-info');
    expect(row).toHaveTextContent('12.3 МБ');
    expect(row).toHaveTextContent(L('common.yes'));
  });

  it('нет оценки хранилища — строка скрыта; нет предложения установки — кнопки нет', async () => {
    renderWithProviders(<AboutSection />);
    await act(async () => undefined);
    expect(screen.queryByTestId('storage-info')).not.toBeInTheDocument();
    expect(screen.queryByTestId('install-app')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ios-install-hint')).not.toBeInTheDocument();
  });

  it('«Установить приложение» появляется после beforeinstallprompt и вызывает системный диалог', async () => {
    const target = new EventTarget();
    listenForInstall(target as unknown as Window);
    renderWithProviders(<AboutSection />);
    const e = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
    e.prompt = vi.fn(async () => undefined);
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    act(() => void target.dispatchEvent(e));
    await userEvent.click(await screen.findByTestId('install-app'));
    expect(e.prompt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('install-app')).not.toBeInTheDocument());
  });

  it('iOS Safari вне standalone: подсказка «Поделиться → На экран Домой»', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    });
    renderWithProviders(<AboutSection />);
    expect(await screen.findByTestId('ios-install-hint')).toHaveTextContent(L('pwa.iosHint'));
  });
});
