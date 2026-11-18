import { act, fireEvent, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as catalogApi from '@/lib/api/catalog';
import { appData } from '@/lib/app-data';
import { en } from '@/lib/i18n/messages/en';
import type { TFn } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { resetPlayer } from '@/lib/player';
import { playRemoteApp, SLOW_PENDING_MS } from '@/lib/search/play-remote';
import { installTestPlayer, seedPlayerLibrary } from '@/test/player-ui';
import { renderWithProviders } from '@/test/render';
import { PlayPending } from './play-pending';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => true }));
vi.mock('@/lib/api/catalog', async importOriginal => ({
  ...(await importOriginal<typeof catalogApi>()),
  requestPlay: vi.fn(),
}));

const t = ((key: string, params?: Record<string, string | number>) => translate(en as never, 'en', key, params)) as TFn;
const request = { albumMbid: 'rg-new', mbid: 'rec-new', title: 'New Song' };

beforeEach(() => {
  seedPlayerLibrary();
  installTestPlayer();
  vi.spyOn(toast, 'loading').mockReturnValue(1);
  vi.spyOn(toast, 'info').mockReturnValue(1);
  vi.spyOn(toast, 'dismiss').mockReturnValue(1);
  vi.mocked(catalogApi.requestPlay).mockResolvedValue({
    album_id: 2,
    track_ids: [900],
    tracks: [{ id: 900, status: 'adding' }],
  });
});
afterEach(() => {
  playRemoteApp().cancel();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPlayer(true);
});

describe('индикатор ожидания источника', () => {
  it('виден на любом экране, пока ждём; без ожидания — нет', async () => {
    renderWithProviders(<PlayPending />);
    expect(screen.queryByTestId('play-pending')).not.toBeInTheDocument();
    playRemoteApp().playRemote(request, t);
    await act(async () => undefined);
    expect(screen.getByTestId('play-pending')).toHaveTextContent('New Song');
    expect(screen.getByTestId('play-pending-stage')).not.toHaveTextContent('/');
  });

  it('стадия: проверка раздач — «N/M» по прогрессу альбома из ответа сервера', async () => {
    renderWithProviders(<PlayPending />);
    playRemoteApp().playRemote(request, t);
    await act(async () => undefined);
    act(() => appData().live.getState().setAlbumProgress(2, { done: 2, stage: 'verifying', total: 5 }));
    expect(screen.getByTestId('play-pending-stage')).toHaveTextContent('2/5');
  });

  it('slow_pending_hint: через SLOW_PENDING_MS — «может занять несколько минут»', async () => {
    vi.useFakeTimers();
    renderWithProviders(<PlayPending />);
    playRemoteApp().playRemote(request, t);
    await act(async () => undefined);
    expect(screen.getByTestId('play-pending-stage')).not.toHaveTextContent('несколько минут');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_PENDING_MS);
    });
    expect(screen.getByTestId('play-pending-stage')).toHaveTextContent('несколько минут');
  });

  it('«Отмена» снимает ожидание и показывает toast отмены', async () => {
    renderWithProviders(<PlayPending />);
    playRemoteApp().playRemote(request, t);
    await act(async () => undefined);
    fireEvent.click(screen.getByTestId('play-pending-cancel'));
    expect(screen.queryByTestId('play-pending')).not.toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith('Waiting cancelled', expect.objectContaining({ duration: 3000 }));
  });
});
