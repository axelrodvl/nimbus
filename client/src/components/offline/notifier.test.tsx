import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackMenu } from '@/components/player/track-menu';
import { resetAppData } from '@/lib/app-data';
import { installOffline } from '@/lib/offline';
import { NOTIFY_KEY } from '@/lib/offline/notify';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { fileStatus, installOfflineUi, type OfflineUi } from '@/test/offline-ui';
import { renderRoutes, renderWithProviders } from '@/test/render';
import { seed } from '@/test/seed';
import { OfflineNotifier } from './notifier';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

let ui: OfflineUi;
beforeEach(() => {
  resetFactories();
  vi.clearAllMocks();
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 1, title: 'Alb' })],
    artists: [makeArtist({ id: 1 })],
    tracks: [makeTrack({ album_id: 1, id: 1, title: 'Song' })],
  });
  ui = installOfflineUi();
});
afterEach(async () => {
  installOffline(null);
  await resetAppData(true);
});

describe('OfflineNotifier', () => {
  it('сообщает о закрепленном альбоме, ставшем доступным, и открывает настройки при нехватке места', async () => {
    const { router } = renderRoutes(
      [
        { element: <OfflineNotifier />, path: '/' },
        { element: <p>settings</p>, path: '/settings/offline' },
      ],
      '/',
    );
    localStorage.setItem(NOTIFY_KEY, JSON.stringify({ 'album:1': 'Alb' }));
    ui.set({ 1: fileStatus('done', 1, 1) }, { pins: new Set(['album:1']) });
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Alb” is available offline', expect.anything()));
    ui.set({}, { blocked: 'quota' });
    await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    const opts = vi.mocked(toast.warning).mock.calls[0]?.[1] as unknown as { action: { onClick: () => void } };
    act(() => opts.action.onClick());
    expect(router.state.location.pathname).toBe('/settings/offline');
  });

  it('без поддержки не подписывается', async () => {
    installOfflineUi({ supported: false });
    renderWithProviders(<OfflineNotifier />);
    localStorage.setItem(NOTIFY_KEY, JSON.stringify({ 'album:1': 'Alb' }));
    await act(async () => undefined);
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('меню трека в плеере', () => {
  it('содержит пункт «Скачать на устройство»', async () => {
    renderWithProviders(<TrackMenu track={{ albumId: 1, id: 1, title: 'Song' } as never} />);
    await userEvent.click(screen.getByTestId('player-track-menu'));
    await userEvent.click(await screen.findByTestId('track-offline-item'));
    expect(ui.manager.pin).toHaveBeenCalledWith('track', 1);
  });
});
