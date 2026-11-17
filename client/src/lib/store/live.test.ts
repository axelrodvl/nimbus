import { describe, expect, it } from 'vitest';
import { createLiveStore } from './live';

describe('live store', () => {
  it('прогресс альбома сохраняется; завершённая проверка убирается', () => {
    const live = createLiveStore();
    live.getState().setAlbumProgress(1, { done: 1, stage: 'searching', total: 4 });
    expect(live.getState().albumProgress.get(1)).toEqual({ done: 1, stage: 'searching', total: 4 });
    live.getState().setAlbumProgress(1, { done: 2, stage: 'verifying', total: 4 });
    expect(live.getState().albumProgress.has(1)).toBe(true);
    live.getState().setAlbumProgress(1, { done: 4, stage: 'verifying', total: 4 });
    expect(live.getState().albumProgress.has(1)).toBe(false);
  });

  it('прогресс потока убирается, когда всё получено; clear очищает всё', () => {
    const live = createLiveStore();
    const p = { bytes_done: 10, bytes_total: 100, down_speed_bps: 5, peers: 2 };
    live.getState().setStreamProgress(3, p);
    expect(live.getState().streamProgress.get(3)).toEqual(p);
    live.getState().setStreamProgress(3, { ...p, bytes_done: 100 });
    expect(live.getState().streamProgress.has(3)).toBe(false);
    live.getState().setStreamProgress(3, p);
    live.getState().setAlbumProgress(1, { done: 0, stage: 'searching', total: 1 });
    live.getState().clear();
    expect(live.getState().streamProgress.size + live.getState().albumProgress.size).toBe(0);
  });

  it('прогресс загрузки на сервер хранится по альбому и обновляется целиком', () => {
    const live = createLiveStore();
    live.getState().setDownloadProgress(2, { bytes_done: 1, bytes_total: 10, down_bps: 5, peers: 1 });
    live.getState().setDownloadProgress(2, { bytes_done: 4, bytes_total: 10, down_bps: 6, peers: 2 });
    expect(live.getState().downloadProgress.get(2)).toEqual({ bytes_done: 4, bytes_total: 10, down_bps: 6, peers: 2 });
    expect(live.getState().downloadProgress.has(3)).toBe(false);
  });

  it('applyProgress: одно уведомление на пачку; завершённое и dropAlbums убираются; пустая пачка не будит', () => {
    const live = createLiveStore();
    live.getState().setAlbumProgress(7, { done: 1, stage: 'searching', total: 2 });
    live.getState().setDownloadProgress(2, { bytes_done: 1, bytes_total: 10, down_bps: 1, peers: 1 });
    let notified = 0;
    live.subscribe(() => (notified += 1));
    live.getState().applyProgress({
      album: new Map([[1, { done: 1, stage: 'searching' as const, total: 3 }]]),
      download: new Map([[2, { bytes_done: 10, bytes_total: 10, down_bps: 0, peers: 0 }]]),
      dropAlbums: [7],
      stream: new Map([[5, { bytes_done: 1, bytes_total: 9, down_speed_bps: 1, peers: 1 }]]),
    });
    expect(notified).toBe(1);
    expect(live.getState().albumProgress.has(1)).toBe(true);
    expect(live.getState().albumProgress.has(7)).toBe(false);
    expect(live.getState().downloadProgress.has(2)).toBe(false);
    expect(live.getState().streamProgress.get(5)?.peers).toBe(1);
    live.getState().applyProgress({});
    expect(notified).toBe(1);
  });
});
