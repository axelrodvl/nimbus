import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appData, resetAppData } from '@/lib/app-data';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { seed } from '@/test/seed';
import { useFavorites, useSearchLocal } from './hooks';

beforeEach(() => {
  resetFactories();
  vi.useFakeTimers();
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 1 })],
    artists: [makeArtist({ id: 1 })],
    tracks: [makeTrack({ album_id: 1, id: 1, play_count: 3, title: 'Alpha' })],
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await resetAppData(false);
});

describe('useThrottledLibrary', () => {
  it('useFavorites recomputes at most twice for 100 status updates within 100 ms', () => {
    const spy = vi.spyOn(appData().selectors, 'favorites');
    renderHook(() => useFavorites());
    spy.mockClear();
    for (let i = 0; i < 100; i++) {
      act(() => {
        appData()
          .library.getState()
          .patchTrack(1, { play_count: 3 + i });
        vi.advanceTimersByTime(1);
      });
    }
    act(() => void vi.advanceTimersByTime(300));
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('first value for a new argument is computed immediately', () => {
    const { result, rerender } = renderHook(({ q }) => useSearchLocal(q, 5), { initialProps: { q: 'zzz' } });
    expect(result.current.tracks).toHaveLength(0);
    rerender({ q: 'alp' });
    expect(result.current.tracks).toHaveLength(1);
  });
});
