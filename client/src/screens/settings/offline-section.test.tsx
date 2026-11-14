import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppData } from '@/lib/app-data';
import { installOffline } from '@/lib/offline';
import { fileStatus, installOfflineUi, type OfflineUi } from '@/test/offline-ui';
import { renderRoutes } from '@/test/render';
import { SettingsScreen } from './settings-screen';

vi.mock('@/lib/api/settings', () => ({
  fetchServerVersion: vi.fn(async () => '9.9.9'),
  fetchSettings: vi.fn(async () => ({})),
  fetchStorage: vi.fn(),
  loadPrefetchEnabled: async () => true,
  putSettings: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const GB = 1024 ** 3;
let ui: OfflineUi;

beforeEach(() => {
  ui = installOfflineUi();
  localStorage.clear();
});
afterEach(async () => {
  installOffline(null);
  await resetAppData(true);
  Reflect.deleteProperty(navigator, 'connection');
  Reflect.deleteProperty(navigator, 'storage');
});

const open = (path = '/settings/offline') =>
  renderRoutes([{ element: <SettingsScreen />, path: '/settings/:section?' }], path);

function stubStorage(persisted: boolean, persist = vi.fn(async () => true)) {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { estimate: async () => ({ quota: 100 * GB, usage: GB }), persist, persisted: async () => persisted },
  });
  return persist;
}

describe('раздел «Офлайн на этом устройстве»', () => {
  it('есть в списке разделов и открывается без сервера', async () => {
    stubStorage(false);
    open('/settings');
    expect(screen.getByTestId('settings-link-offline')).toHaveTextContent('Офлайн на этом устройстве');
    await userEvent.click(screen.getByTestId('settings-link-offline'));
    expect(await screen.findByTestId('settings-offline')).toBeInTheDocument();
  });

  it('лимит места: ползунок сохраняет в настройки устройства; показано занятое', async () => {
    stubStorage(false);
    open();
    ui.set({}, { usage: { bytes: 2 * GB, limit: 10 * GB, quota: 40 * GB } });
    expect(screen.getByTestId('offline-usage')).toHaveTextContent('Занято 2.0 ГБ из 20 ГБ');
    const slider = screen.getByTestId('offline-limit');
    expect(slider).toHaveAttribute('max', '40');
    expect(slider).toHaveAttribute('min', '1');
    fireEvent.change(slider, { target: { value: '12' } });
    fireEvent.blur(slider);
    expect(ui.rt.settings.getState().limitBytes).toBe(12 * GB);
    expect(JSON.parse(localStorage.getItem('nimbus:offline-settings') ?? '{}')).toMatchObject({ limitBytes: 12 * GB });
  });

  it('квота неизвестна — ползунок до 50 ГБ; лимит по умолчанию отражается на ползунке', () => {
    stubStorage(false);
    open();
    expect(screen.getByTestId('offline-limit')).toHaveAttribute('max', '50');
    expect(screen.getByTestId('offline-limit')).toHaveValue('20');
  });

  it('одновременных загрузок 1…6: значение применяется к настройкам и ограничивается', async () => {
    stubStorage(false);
    open();
    const input = screen.getByTestId('offline-concurrency');
    expect(input).toHaveValue(3);
    await userEvent.clear(input);
    await userEvent.type(input, '5{Enter}');
    expect(ui.rt.settings.getState().concurrency).toBe(5);
    await userEvent.clear(input);
    await userEvent.type(input, '99{Enter}');
    expect(ui.rt.settings.getState().concurrency).toBe(6);
  });

  it('«Только по Wi-Fi» скрыта без navigator.connection и работает с ним', async () => {
    stubStorage(false);
    const { unmount } = open();
    expect(screen.queryByTestId('offline-wifi')).toBeNull();
    unmount();
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { type: 'wifi' } });
    open();
    const sw = screen.getByTestId('offline-wifi');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(ui.rt.settings.getState().wifiOnly).toBe(true);
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('постоянное хранилище: состояние и запрос по кнопке', async () => {
    const persist = stubStorage(false);
    open();
    await waitFor(() => expect(screen.getByTestId('offline-persistent')).toHaveTextContent('Нет'));
    const button = screen.getByTestId('offline-persist-request');
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(persist).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('offline-persistent')).toHaveTextContent('Да'));
    expect(button).toBeDisabled();
  });

  it('постоянное хранилище уже выдано — кнопка недоступна', async () => {
    stubStorage(true);
    open();
    await waitFor(() => expect(screen.getByTestId('offline-persistent')).toHaveTextContent('Да'));
    expect(screen.getByTestId('offline-persist-request')).toBeDisabled();
  });

  it('«Удалить всё скачанное»: подтверждение с объёмом и числом треков, затем removeAll', async () => {
    stubStorage(false);
    open();
    const del = screen.getByTestId('offline-delete-all');
    expect(del).toBeDisabled();
    ui.set({ 1: fileStatus('done', 3 * GB, 3 * GB), 2: fileStatus('done', 1024 ** 2, 1024 ** 2) });
    expect(del).toBeEnabled();
    await userEvent.click(del);
    const dialog = await screen.findByRole('dialog', { name: 'Удалить всё скачанное' });
    expect(dialog).toHaveTextContent('треков: 2 (3.0 ГБ)');
    expect(ui.manager.removeAll).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(ui.manager.removeAll).not.toHaveBeenCalled();
    await userEvent.click(del);
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Удалить всё скачанное' }),
    );
    await waitFor(() => expect(ui.manager.removeAll).toHaveBeenCalledTimes(1));
  });

  it('без офлайн-хранилища раздела нет, адрес — «не найдено», а в «О приложении» одна строка про это', async () => {
    installOfflineUi({ supported: false });
    const first = open('/settings/offline');
    expect(screen.queryByTestId('settings-offline')).toBeNull();
    first.unmount();
    open('/settings/about');
    expect(screen.queryByTestId('settings-link-offline')).toBeNull();
    expect(await screen.findByTestId('offline-unsupported')).toHaveTextContent(
      'Этот браузер не поддерживает хранение музыки на устройстве',
    );
  });

  it('с поддержкой строки про отсутствие поддержки нет', async () => {
    stubStorage(false);
    open('/settings/about');
    await screen.findByTestId('settings-about');
    expect(screen.queryByTestId('offline-unsupported')).toBeNull();
    await act(async () => undefined);
  });
});
