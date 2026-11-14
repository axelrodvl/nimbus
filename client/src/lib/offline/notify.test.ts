import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRows } from '@/lib/db/types';
import { createLibraryStore } from '@/lib/store/library';
import { makeAlbum, makeArtist, makeTrack } from '@/test/factories';
import { fileStatus } from '@/test/offline-ui';
import type { tNow } from '@/lib/i18n/t-now';
import { createOfflineNotifier, expectCompletion, forgetCompletion, NOTIFY_KEY } from './notify';
import { createOfflineStatusStore, type OfflineFileStatus } from './status';

const t = ((key: string, params?: Record<string, string | number>) =>
  `${key}${params ? JSON.stringify(params) : ''}`) as unknown as typeof tNow;

function setup(storage: Storage = localStorage) {
  const library = createLibraryStore();
  library.getState().hydrate({
    ...emptyRows(),
    albums: [makeAlbum({ id: 1, title: 'One' }), makeAlbum({ id: 2, title: 'Two' })],
    artists: [makeArtist({ id: 1 })],
    tracks: [
      makeTrack({ album_id: 1, id: 1, position: 1, title: 'T1' }),
      makeTrack({ album_id: 1, id: 2, position: 2, title: 'T2' }),
      makeTrack({ album_id: 2, id: 3, position: 1, title: 'T3' }),
    ],
  });
  const status = createOfflineStatusStore(true);
  const toast = { error: vi.fn(), success: vi.fn(), warning: vi.fn() };
  const openSettings = vi.fn();
  const notifier = createOfflineNotifier({
    batchMs: 10,
    favoriteIds: () => [],
    library,
    openSettings,
    status,
    storage,
    t,
    toast,
  });
  const files = (m: Record<number, OfflineFileStatus>) =>
    status.setState({ files: new Map(Object.entries(m).map(([k, v]) => [Number(k), v])) });
  return { files, library, notifier, openSettings, status, toast };
}

const DONE = fileStatus('done', 1, 1);
const pending = () => JSON.parse(localStorage.getItem(NOTIFY_KEY) ?? '{}') as Record<string, string>;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ожидание завершения', () => {
  it('запоминается в хранилище и забывается', () => {
    expectCompletion('album:1', 'One');
    expectCompletion('album:2', 'Two');
    expect(pending()).toEqual({ 'album:1': 'One', 'album:2': 'Two' });
    forgetCompletion('album:1');
    forgetCompletion('album:77');
    expect(pending()).toEqual({ 'album:2': 'Two' });
  });

  it('испорченное и недоступное хранилище не ломает работу', () => {
    localStorage.setItem(NOTIFY_KEY, '[1,2]');
    expectCompletion('album:1', 'One');
    expect(pending()).toEqual({ 'album:1': 'One' });
    localStorage.setItem(NOTIFY_KEY, '{oops');
    forgetCompletion('album:1');
    expect(() => expectCompletion('x', 'y', null)).not.toThrow();
    const broken = {
      getItem: () => '{"a":1,"b":"ok"}',
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => expectCompletion('album:3', 'T', broken)).not.toThrow();
  });
});

describe('уведомления', () => {
  it('закрепление целиком: ровно один toast, повторные изменения его не дублируют', () => {
    const h = setup();
    expectCompletion('album:1', 'One');
    h.status.setState({ pins: new Set(['album:1']) });
    h.files({ 1: DONE, 2: fileStatus('downloading', 1, 2) });
    h.notifier.check();
    vi.advanceTimersByTime(20);
    expect(h.toast.success).not.toHaveBeenCalled();
    h.files({ 1: DONE, 2: DONE });
    h.notifier.check();
    h.notifier.check();
    vi.advanceTimersByTime(20);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(h.toast.success).toHaveBeenCalledWith('offline.toast.done{"title":"One"}', { id: 'offline-done-One' });
    h.files({ 1: DONE, 2: DONE, 3: DONE });
    h.notifier.check();
    vi.advanceTimersByTime(20);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(pending()).toEqual({});
  });

  it('сразу несколько закреплений — один сводный toast', () => {
    const h = setup();
    expectCompletion('album:1', 'One');
    expectCompletion('album:2', 'Two');
    h.status.setState({ pins: new Set(['album:1', 'album:2']) });
    h.files({ 1: DONE, 2: DONE, 3: DONE });
    h.notifier.check();
    vi.advanceTimersByTime(20);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(h.toast.success).toHaveBeenCalledWith('offline.toast.doneMany{"count":2}', { id: 'offline-done' });
  });

  it('закрепление, начатое до перезагрузки и законченное после неё, даёт один toast', () => {
    expectCompletion('album:1', 'One');
    // «Новая страница»: новый уведомитель с тем же хранилищем; сначала состояние ещё не загружено.
    const h = setup();
    h.notifier.check();
    h.status.setState({ pins: new Set(['album:1']) });
    h.files({ 1: fileStatus('downloading', 1, 2), 2: fileStatus('queued') });
    h.notifier.check();
    h.files({ 1: DONE, 2: DONE });
    h.notifier.check();
    vi.advanceTimersByTime(20);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    // Ещё одна вкладка с тем же ожиданием уже ничего не найдёт.
    const other = setup();
    other.status.setState({ pins: new Set(['album:1']) });
    other.files({ 1: DONE, 2: DONE });
    other.notifier.check();
    vi.advanceTimersByTime(20);
    expect(other.toast.success).not.toHaveBeenCalled();
  });

  it('две вкладки заметили завершение одновременно — toast только у первой', () => {
    expectCompletion('album:1', 'One');
    const a = setup();
    const b = setup();
    for (const h of [a, b]) {
      h.status.setState({ pins: new Set(['album:1']) });
      h.files({ 1: DONE, 2: DONE });
      h.notifier.check();
    }
    vi.advanceTimersByTime(20);
    expect(a.toast.success.mock.calls.length + b.toast.success.mock.calls.length).toBe(1);
  });

  it('закрепление снято до завершения — ожидание сбрасывается без toast', () => {
    const h = setup();
    expectCompletion('album:1', 'One');
    h.status.setState({ pins: new Set(['album:2']) });
    h.files({ 3: fileStatus('queued') });
    h.notifier.check();
    expect(pending()).toEqual({});
    h.files({ 1: DONE, 2: DONE });
    h.notifier.check();
    vi.advanceTimersByTime(20);
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it('до загрузки состояния и библиотеки ожидание не трогается', () => {
    const h = setup();
    expectCompletion('album:1', 'One');
    h.notifier.check();
    expect(pending()).toEqual({ 'album:1': 'One' });
    const unhydrated = setup();
    unhydrated.library.getState().reset();
    unhydrated.status.setState({ pins: new Set(['album:1']) });
    unhydrated.notifier.check();
    expect(pending()).toEqual({ 'album:1': 'One' });
  });

  it('остановка из-за места: один toast с переходом в настройки', () => {
    const h = setup();
    h.status.setState({ blocked: 'quota' });
    h.notifier.check();
    h.status.setState({ blocked: 'quota', queueLength: 3 });
    h.notifier.check();
    expect(h.toast.warning).toHaveBeenCalledTimes(1);
    const opts = h.toast.warning.mock.calls[0]?.[1] as { action: { label: string; onClick: () => void } };
    expect(opts.action.label).toBe('offline.toast.openSettings');
    opts.action.onClick();
    expect(h.openSettings).toHaveBeenCalled();
    // Снова остановилась после того, как место появилось, — новый toast.
    h.status.setState({ blocked: 'none' });
    h.notifier.check();
    h.status.setState({ blocked: 'quota' });
    h.notifier.check();
    expect(h.toast.warning).toHaveBeenCalledTimes(2);
  });

  it('окончательная ошибка: toast на переход в «failed», не на уже упавшие при старте', () => {
    const h = setup();
    h.files({ 1: fileStatus('failed'), 2: fileStatus('downloading') });
    h.notifier.check();
    vi.advanceTimersByTime(20);
    expect(h.toast.error).not.toHaveBeenCalled();
    h.files({ 1: fileStatus('failed'), 2: fileStatus('failed') });
    h.notifier.check();
    vi.advanceTimersByTime(20);
    expect(h.toast.error).toHaveBeenCalledWith('offline.toast.failedOne{"title":"T2"}', { id: 'offline-failed' });
    // Несколько сразу — сводный.
    h.files({ 1: fileStatus('queued'), 2: fileStatus('queued'), 3: fileStatus('queued') });
    h.notifier.check();
    h.files({ 1: fileStatus('failed'), 2: fileStatus('failed'), 3: fileStatus('failed') });
    h.notifier.check();
    vi.advanceTimersByTime(20);
    expect(h.toast.error).toHaveBeenLastCalledWith('offline.toast.failedMany{"count":3}', { id: 'offline-failed' });
    // Исчезнувшие файлы забываются.
    h.files({});
    h.notifier.check();
  });

  it('без поддержки и после dispose ничего не делает; события сворачиваются в одну проверку', async () => {
    const h = setup();
    expectCompletion('album:1', 'One');
    h.status.setState({ pins: new Set(['album:1']) });
    h.files({ 1: DONE, 2: DONE });
    h.status.setState({ supported: false });
    h.notifier.check();
    h.status.setState({ supported: true });
    h.notifier.dispose();
    h.notifier.check();
    await vi.advanceTimersByTimeAsync(20);
    expect(h.toast.success).not.toHaveBeenCalled();
    // Подписка: изменение store запускает проверку в микрозадаче.
    const live = setup();
    expectCompletion('album:1', 'One');
    live.status.setState({ pins: new Set(['album:1']) });
    live.files({ 1: DONE, 2: DONE });
    await vi.advanceTimersByTimeAsync(20);
    expect(live.toast.success).toHaveBeenCalledTimes(1);
  });
});
