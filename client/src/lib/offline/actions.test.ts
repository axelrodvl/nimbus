import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installOffline } from '@/lib/offline';
import { fileStatus, installOfflineUi, type OfflineUi } from '@/test/offline-ui';
import {
  favoritesSubject,
  pinKey,
  pinSubject,
  removeSubject,
  retryAllFailed,
  retryTracks,
  setOfflinePaused,
} from './actions';
import { NOTIFY_KEY } from './notify';

let ui: OfflineUi;
beforeEach(() => {
  ui = installOfflineUi();
});
afterEach(() => installOffline(null));

const pending = () => JSON.parse(localStorage.getItem(NOTIFY_KEY) ?? '{}') as Record<string, string>;

describe('действия', () => {
  it('закрепление (жест пользователя) просит постоянное хранилище', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { ...globalThis.navigator, storage: { persist } });
    await pinSubject({ id: 4, kind: 'album', title: 'Four', trackIds: [1] });
    vi.unstubAllGlobals();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('закрепление запоминает, что о нём надо сообщить, и вызывает менеджер', async () => {
    await pinSubject({ id: 4, kind: 'album', title: 'Four', trackIds: [1, 2] });
    expect(ui.manager.pin).toHaveBeenCalledWith('album', 4);
    expect(pending()).toEqual({ 'album:4': 'Four' });
  });

  it('удаление снимает закрепление сущности и закрепления её треков; ожидание забывается', async () => {
    const subject = { id: 4, kind: 'album', title: 'Four', trackIds: [1, 2] } as const;
    await pinSubject(subject);
    await removeSubject(subject);
    expect(ui.manager.unpin.mock.calls).toEqual([
      ['album', 4],
      ['track', 1],
      ['track', 2],
    ]);
    expect(pending()).toEqual({});
    // Для трека отдельных закреплений треков нет.
    ui.manager.unpin.mockClear();
    await removeSubject({ id: 9, kind: 'track', title: 'T', trackIds: [9] });
    expect(ui.manager.unpin.mock.calls).toEqual([['track', 9]]);
  });

  it('повтор — только для упавших треков; «повторить всё»; пауза', () => {
    ui.set({ 1: fileStatus('failed'), 2: fileStatus('done'), 3: fileStatus('failed') });
    retryTracks([1, 2]);
    expect(ui.manager.retry.mock.calls).toEqual([[1]]);
    ui.manager.retry.mockClear();
    retryAllFailed();
    expect(ui.manager.retry.mock.calls).toEqual([[1], [3]]);
    setOfflinePaused(true);
    expect(ui.manager.setPaused).toHaveBeenCalledWith(true);
  });

  it('без запущенного менеджера действия ничего не делают', async () => {
    ui.rt.manager = null;
    await expect(pinSubject({ id: 1, kind: 'track', title: 'x', trackIds: [1] })).resolves.toBeUndefined();
    await expect(removeSubject({ id: 1, kind: 'track', title: 'x', trackIds: [1] })).resolves.toBeUndefined();
    expect(() => {
      retryTracks([1]);
      retryAllFailed();
      setOfflinePaused(false);
    }).not.toThrow();
  });

  it('вспомогательные: ключ и «Избранное»', () => {
    expect(pinKey('playlist', 3)).toBe('playlist:3');
    expect(favoritesSubject('Fav', [1])).toEqual({ id: 0, kind: 'playlist', title: 'Fav', trackIds: [1] });
  });
});
