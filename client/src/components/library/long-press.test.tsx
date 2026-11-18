import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAlbum, makeTrack } from '@/test/factories';
import { renderWithProviders } from '@/test/render';
import { setHaptics } from '@/lib/platform/haptics';
import { AlbumCard } from './album-card';
import { TrackRow } from './track-row';

const trackView = { ...makeTrack({ id: 5 }), albumTitle: 'Album', artistName: 'Artist', coverUrl: null };
const touch = (extra: object = {}) => ({ clientX: 10, clientY: 10, isPrimary: true, pointerType: 'touch', ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (q: string) => ({
    addEventListener() {},
    matches: q.includes('pointer: coarse'),
    removeEventListener() {},
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setHaptics(null);
});

describe('долгое нажатие', () => {
  it('на строке трека нажимает кнопку «…» (то же меню), с откликом; click после него подавлен', () => {
    const impact = vi.fn();
    setHaptics({ impact });
    const menu = vi.fn();
    const row = vi.fn();
    renderWithProviders(
      <TrackRow
        actions={
          <button data-menu-trigger onClick={menu} type="button">
            …
          </button>
        }
        leading={<span data-testid="lead" onClick={row} />}
        track={trackView}
      />,
    );
    const el = screen.getByTestId('track-row');
    fireEvent.pointerDown(el, touch());
    act(() => void vi.advanceTimersByTime(500));
    expect(menu).toHaveBeenCalledTimes(1);
    expect(impact).toHaveBeenCalledWith('tap');
    fireEvent.pointerUp(el, touch());
    fireEvent.click(screen.getByTestId('lead'));
    expect(row).not.toHaveBeenCalled(); // отпускание пальца не запускает трек
    fireEvent.click(screen.getByTestId('lead'));
    expect(row).toHaveBeenCalledTimes(1);
  });

  it('сдвиг больше 10 px и отпускание отменяют; мышь не участвует', () => {
    const menu = vi.fn();
    renderWithProviders(
      <TrackRow
        actions={
          <button data-menu-trigger onClick={menu} type="button">
            …
          </button>
        }
        track={trackView}
      />,
    );
    const el = screen.getByTestId('track-row');
    fireEvent.pointerDown(el, touch());
    fireEvent.pointerMove(el, touch({ clientX: 30 }));
    act(() => void vi.advanceTimersByTime(600));
    fireEvent.pointerDown(el, touch());
    act(() => void vi.advanceTimersByTime(200));
    fireEvent.pointerUp(el, touch());
    act(() => void vi.advanceTimersByTime(600));
    fireEvent.pointerDown(el, touch({ pointerType: 'mouse' }));
    act(() => void vi.advanceTimersByTime(600));
    expect(menu).not.toHaveBeenCalled();
  });

  it('системное контекстное меню на сенсорном устройстве подавлено', () => {
    renderWithProviders(<TrackRow track={trackView} />);
    const allowed = fireEvent.contextMenu(screen.getByTestId('track-row'));
    expect(allowed).toBe(false);
  });

  it('на карточке альбома открывает меню «К альбому / К артисту»', () => {
    renderWithProviders(
      <AlbumCard album={{ ...makeAlbum({ id: 3 }), artistName: 'A', statusCounts: {} as never, trackCount: 1 }} />,
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId('album-card'), touch());
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Перейти к альбому', 'Перейти к артисту']);
  });
});
