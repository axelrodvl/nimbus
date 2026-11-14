import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAppData } from '@/lib/app-data';
import { createOfflineRuntime, installOffline } from '@/lib/offline';
import { MemoryStorage } from '@/test/offline';
import { seed } from '@/test/seed';
import { useCanPlay } from './hooks';

afterEach(async () => {
  installOffline(null);
  await resetAppData(true);
});

describe('useCanPlay', () => {
  it('перерисовывается, когда трек становится доступен без сети или пропадает связь', () => {
    seed({});
    const rt = createOfflineRuntime(new MemoryStorage());
    installOffline(rt);
    const { result } = renderHook(() => useCanPlay());
    const track = { id: 7, status: 'adding' as const };
    expect(result.current(track)).toBe(false);
    const first = result.current;
    act(() => {
      rt.status.setState({ files: new Map([[7, { bytesDone: 1, bytesTotal: 1, error: null, mime: 'a/b', state: 'done' }]]) });
    });
    expect(result.current).not.toBe(first);
    expect(result.current(track)).toBe(true);
    // Связи нет: нескачанный трек недоступен, скачанный — доступен.
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    act(() => void globalThis.dispatchEvent(new Event('offline')));
    expect(result.current({ id: 8, status: 'ready' })).toBe(false);
    expect(result.current({ id: 7, status: 'ready' })).toBe(true);
  });
});
