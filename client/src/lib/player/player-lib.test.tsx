import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appData } from '@/lib/app-data';
import { en } from '@/lib/i18n/messages/en';
import { setApiBase } from '@/lib/platform/urls';
import { makeAlbum, makeArtist, makeTrack } from '@/test/factories';
import { FakeAudioEngine } from '@/test/fake-engine';
import { ids, pt, queue, setup } from '@/test/player';
import { seed } from '@/test/seed';
import {
  useHasNext,
  useIsCurrentTrack,
  useIsTrackPlaying,
  usePlayerActions,
  usePlayerState,
  useProgress,
} from './hooks';
import { PlayerController } from './controller';
import { appPlayerDeps, installPlayer, player, resetPlayer } from './index';
import { notifyPlayerError } from './notify';
import { createProgressSource, PROGRESS_INTERVAL_MS, progressSourceFor } from './progress';
import { playableQueue, queueFromIds } from './queues';
import { activatesOnSpace, installShortcuts, isEditable } from './shortcuts';
import { resolveStreamUrl } from './stream';
import { selectorsFor } from './test-helpers';
import { canPlay, toPlayerTrack } from './track';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => false }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  resetPlayer(true);
  setApiBase('');
});

describe('track', () => {
  it('canPlay: found и ready', () => {
    expect(canPlay({ status: 'found' })).toBe(true);
    expect(canPlay({ status: 'ready' })).toBe(true);
    expect(canPlay({ status: 'adding' })).toBe(false);
    expect(canPlay({ status: 'not_found' })).toBe(false);
  });

  it('toPlayerTrack строится из представления трека', () => {
    seed({
      albums: [makeAlbum({ artist_id: 1, cover_url: 'http://c', id: 2, title: 'Alb' })],
      artists: [makeArtist({ id: 1, name: 'Art' })],
      tracks: [
        makeTrack({
          album_id: 2,
          artist_id: 1,
          duration_ms: 5000,
          id: 3,
          playback: 'transcode',
          status: 'found',
          title: 'Tr',
        }),
        makeTrack({ album_id: 2, artist_id: 1, duration_ms: null, id: 4, playback: 'direct' }),
      ],
    });
    expect(toPlayerTrack(selectorsFor(3)!)).toEqual({
      album: 'Alb',
      albumId: 2,
      artist: 'Art',
      artistId: 1,
      coverUrl: 'http://c',
      durationMs: 5000,
      id: 3,
      playback: 'transcode',
      status: 'found',
      title: 'Tr',
    });
    expect(toPlayerTrack(selectorsFor(4)!)).toMatchObject({ durationMs: null, playback: 'direct' });
  });
});

describe('очереди', () => {
  beforeEach(() => {
    seed({
      albums: [makeAlbum({ id: 2 })],
      artists: [makeArtist({ id: 1 })],
      tracks: [
        makeTrack({ album_id: 2, artist_id: 1, id: 10, status: 'ready' }),
        makeTrack({ album_id: 2, artist_id: 1, id: 11, status: 'adding' }),
        makeTrack({ album_id: 2, artist_id: 1, id: 12, status: 'found' }),
      ],
    });
  });

  it('queueFromIds: только доступные треки, порядок сохраняется; неизвестные id пропускаются', () => {
    expect(queueFromIds([12, 11, 10, 999]).map(t => t.id)).toEqual([12, 10]);
  });

  it('playableQueue: фильтр по доступности', () => {
    const views = [10, 11, 12].map(id => selectorsFor(id)!);
    expect(playableQueue(views).map(t => t.id)).toEqual([10, 12]);
  });
});

describe('адрес потока', () => {
  it('direct и transcode, смещение ?t=, база адреса', () => {
    expect(resolveStreamUrl(pt(5), 0)).toEqual({ headers: {}, mode: 'direct', url: '/api/tracks/5/stream' });
    expect(resolveStreamUrl(pt(5, { playback: 'transcode' }), 3)).toEqual({
      headers: {},
      mode: 'transcode',
      url: '/api/tracks/5/stream?t=3.000',
    });
    setApiBase('https://music.example.com');
    expect((resolveStreamUrl(pt(5), 0) as { url: string }).url).toBe('https://music.example.com/api/tracks/5/stream');
  });
});

describe('горячие клавиши', () => {
  function key(init: KeyboardEventInit, target?: HTMLElement) {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    (target ?? window).dispatchEvent(e);
    return e;
  }

  it('пробел — пауза/продолжить, стрелки — перемотка, Shift+стрелки — трек', () => {
    const s = setup();
    s.ctl.play(s.library.get(2)!, queue(s));
    s.engine.emit({ type: 'playing' });
    const off = installShortcuts(s.ctl);
    const space = key({ code: 'Space', key: ' ' });
    expect(space.defaultPrevented).toBe(true);
    expect(s.engine.paused).toBe(true);
    s.engine.emit({ type: 'paused' });
    key({ code: 'Space' });
    expect(s.engine.playCalls).toBe(1);
    s.engine.setPosition(2);
    key({ key: 'ArrowRight' });
    expect(s.engine.seeks.at(-1)).toBe(7);
    s.engine.setPosition(9);
    key({ key: 'ArrowLeft' });
    expect(s.engine.seeks.at(-1)).toBe(4);
    key({ key: 'ArrowRight', shiftKey: true });
    expect(s.ctl.state.index).toBe(2);
    key({ key: 'ArrowLeft', shiftKey: true });
    expect(s.ctl.state.index).toBe(1);
    off();
    key({ key: 'ArrowRight', shiftKey: true });
    expect(s.ctl.state.index).toBe(1);
  });

  it('не срабатывают в полях ввода, на ползунках, с модификаторами и без трека', () => {
    const s = setup();
    const off = installShortcuts(s.ctl);
    key({ code: 'Space' }); // без трека
    expect(s.engine.loads).toEqual([]);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    const input = document.body.appendChild(document.createElement('input'));
    const slider = document.body.appendChild(document.createElement('div'));
    slider.setAttribute('role', 'slider');
    const button = document.body.appendChild(document.createElement('button'));
    for (const el of [input, slider]) {
      expect(key({ code: 'Space' }, el).defaultPrevented).toBe(false);
      key({ key: 'ArrowRight' }, el);
    }
    expect(s.engine.paused).toBe(false);
    expect(s.engine.seeks).toEqual([]);
    // пробел на кнопке — штатная активация кнопки
    expect(key({ code: 'Space' }, button).defaultPrevented).toBe(false);
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      key({ code: 'Space', ...mod });
      key({ key: 'ArrowRight', ...mod });
    }
    expect(s.engine.paused).toBe(false);
    expect(s.engine.seeks).toEqual([]);
    off();
    for (const el of [input, slider, button]) el.remove();
  });

  it('isEditable / activatesOnSpace', () => {
    const div = document.createElement('div');
    expect(isEditable(div)).toBe(false);
    expect(isEditable(null)).toBe(false);
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isEditable(div)).toBe(true);
    expect(isEditable(document.createElement('textarea'))).toBe(true);
    const role = document.createElement('div');
    role.setAttribute('role', 'textbox');
    expect(isEditable(role)).toBe(true);
    expect(activatesOnSpace(document.createElement('a'))).toBe(true);
    const rb = document.createElement('div');
    rb.setAttribute('role', 'button');
    expect(activatesOnSpace(rb)).toBe(true);
    expect(activatesOnSpace(document.createElement('div'))).toBe(false);
    expect(activatesOnSpace(null)).toBe(false);
  });

  it('pagehide сохраняет состояние', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.setPosition(3);
    const off = installShortcuts(s.ctl);
    const before = s.storage.writes;
    window.dispatchEvent(new Event('pagehide'));
    expect(s.storage.writes).toBe(before + 1);
    expect(JSON.parse(s.storage.data.get('nimbus:player')!).position).toBe(3);
    off();
  });
});

describe('источник позиции и хуки', () => {
  it('createProgressSource: снимок меняется по rAF при игре и не дёргает подписчиков при той же позиции', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    const source = createProgressSource(s.ctl);
    const listener = vi.fn();
    const off = source.subscribe(listener);
    s.engine.setPosition(1, 10, [[0, 3]]);
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS + 20);
    expect(source.getSnapshot()).toEqual({ buffered: [[0, 3]], current: 1, duration: 10 });
    const calls = listener.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    vi.advanceTimersByTime(100);
    expect(listener.mock.calls.length).toBe(calls); // позиция та же — без уведомлений
    s.engine.setPosition(1.02, 10, [[0, 3]]); // сдвиг меньше порога
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS + 20);
    expect(listener.mock.calls.length).toBe(calls);
    s.engine.setPosition(2, 10, [[0, 4]]);
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS + 20);
    expect(source.getSnapshot().current).toBe(2);
    off();
    // после отписки rAF снят: остаётся только таймер тиков контроллера
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  });

  it('progressSourceFor: один источник на контроллер — один цикл rAF при двух подписчиках', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    expect(progressSourceFor(s.ctl)).toBe(progressSourceFor(s.ctl));
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    const offA = progressSourceFor(s.ctl).subscribe(() => undefined);
    const offB = progressSourceFor(s.ctl).subscribe(() => undefined);
    const start = raf.mock.calls.length;
    expect(start).toBe(1); // второй подписчик цикл не заводит
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    const perTick = raf.mock.calls.length - start;
    offB();
    offA();
    const single = vi.spyOn(globalThis, 'requestAnimationFrame');
    single.mockClear();
    const off = createProgressSource(s.ctl).subscribe(() => undefined);
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    off();
    expect(perTick).toBeLessThanOrEqual(single.mock.calls.length - 1);
    raf.mockRestore();
  });

  it('на паузе и в скрытой вкладке rAF не крутится; изменение состояния обновляет снимок', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'paused' });
    const source = createProgressSource(s.ctl);
    const off = source.subscribe(() => undefined);
    const timers = vi.getTimerCount();
    s.engine.setPosition(5, 10);
    vi.advanceTimersByTime(100);
    expect(source.getSnapshot().current).toBe(0);
    s.ctl.seekTo(5); // событие состояния → чтение позиции
    expect(source.getSnapshot().current).toBe(5);
    expect(vi.getTimerCount()).toBe(timers);
    // скрытая вкладка
    s.engine.emit({ type: 'playing' });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    s.engine.setPosition(7, 10);
    vi.advanceTimersByTime(100);
    expect(source.getSnapshot().current).toBe(5);
    off();
  });

  it('другой буфер и другая длительность считаются изменением', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.setPosition(1, 10, [[0, 2]]);
    const source = createProgressSource(s.ctl);
    const off = source.subscribe(() => undefined);
    s.engine.setPosition(1, 10, [
      [0, 2],
      [5, 6],
    ]);
    s.ctl.seekTo(1);
    expect(source.getSnapshot().buffered).toEqual([
      [0, 2],
      [5, 6],
    ]);
    s.engine.setPosition(1, 20, [
      [0, 2],
      [5, 6],
    ]);
    s.ctl.seekTo(1);
    expect(source.getSnapshot().duration).toBe(20);
    off();
  });

  it('хуки читают состояние контроллера', () => {
    const s = setup();
    installPlayer(s.ctl);
    const { result } = renderHook(() => ({
      actions: usePlayerActions(),
      current1: useIsCurrentTrack(1),
      current2: useIsCurrentTrack(2),
      index: usePlayerState(st => st.index),
      playing1: useIsTrackPlaying(1),
      progress: useProgress(),
    }));
    expect(result.current.actions).toBe(s.ctl);
    expect(result.current.index).toBe(-1);
    act(() => s.ctl.play(s.library.get(1)!, queue(s)));
    expect(result.current).toMatchObject({ current1: true, current2: false, index: 0, playing1: true });
    act(() => s.engine.emit({ type: 'paused' }));
    expect(result.current.playing1).toBe(false);
    expect(result.current.current1).toBe(true);
    act(() => {
      s.engine.setPosition(3, 10);
      s.ctl.seekTo(3);
    });
    expect(result.current.progress.current).toBe(3);
  });
});

describe('useHasNext', () => {
  it('реагирует и на очередь, и на статус следующего трека в библиотеке', () => {
    seed({
      albums: [makeAlbum({ id: 2 })],
      artists: [makeArtist({ id: 1 })],
      tracks: [
        makeTrack({ album_id: 2, artist_id: 1, id: 10, status: 'ready' }),
        makeTrack({ album_id: 2, artist_id: 1, id: 11, status: 'found' }),
      ],
    });
    const ctl = new PlayerController(appPlayerDeps({ engine: new FakeAudioEngine(), storage: undefined }));
    installPlayer(ctl);
    const { result } = renderHook(() => useHasNext());
    expect(result.current).toBe(false);
    act(() => ctl.play(pt(10), [pt(10), pt(11)]));
    expect(result.current).toBe(true);
    act(() => appData().library.getState().patchTrack(11, { status: 'not_found' }));
    expect(result.current).toBe(false);
    act(() => appData().library.getState().patchTrack(11, { status: 'ready' }));
    expect(result.current).toBe(true);
  });
});

describe('приложение: зависимости и синглтон', () => {
  it('player() один на приложение; resetPlayer(true) стирает очередь и создаёт новый', () => {
    const a = player();
    expect(player()).toBe(a);
    a.play(pt(1));
    expect(localStorage.getItem('nimbus:player')).not.toBeNull();
    resetPlayer(true);
    expect(localStorage.getItem('nimbus:player')).toBeNull();
    expect(player()).not.toBe(a);
  });

  it('resetPlayer без очистки оставляет очередь для следующего входа', () => {
    player().play(pt(1), [pt(1), pt(2)]);
    resetPlayer(false);
    expect(ids(player())).toEqual([1, 2]);
    expect(player().state.isPlaying).toBe(false);
  });

  it('installPlayer заменяет контроллер и останавливает прежний', () => {
    const s = setup();
    const before = player();
    const destroy = vi.spyOn(before, 'destroy');
    installPlayer(s.ctl);
    expect(destroy).toHaveBeenCalled();
    expect(player()).toBe(s.ctl);
  });

  it('appPlayerDeps: библиотека из appData, статусы живые, настройка предзагрузки читается один раз', async () => {
    seed({
      albums: [makeAlbum({ id: 2 })],
      artists: [makeArtist({ id: 1 })],
      tracks: [makeTrack({ album_id: 2, artist_id: 1, id: 10, status: 'found' })],
    });
    const deps = appPlayerDeps();
    expect(deps.libraryReady()).toBe(true);
    expect(deps.getTrack(10)).toMatchObject({ id: 10, status: 'found' });
    expect(deps.getTrack(404)).toBeUndefined();
    const listener = vi.fn();
    const off = deps.subscribeLibrary!(listener);
    appData().library.getState().patchTrack(10, { status: 'ready' });
    expect(listener).toHaveBeenCalled();
    expect(deps.getTrack(10)?.status).toBe('ready');
    off();
    expect(deps.prefetchEnabled()).toBe(true); // пока настройки не загрузились
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.prefetchEnabled()).toBe(false); // значение из настроек
  });

  it('notifyPlayerError показывает toast «Название: причина»', () => {
    const spy = vi.spyOn(toast, 'error').mockReturnValue(1);
    notifyPlayerError(pt(1), { code: 'no_peers' });
    expect(spy).toHaveBeenCalledWith(`T1: ${en['player.error.no_peers']}`);
    notifyPlayerError(pt(1), { code: 'weird' });
    expect(spy).toHaveBeenLastCalledWith(`T1: ${en['player.error.default']}`);
  });
});

describe('позиция без загруженного трека', () => {
  it('после перезапуска и отмены показывается сохранённая позиция, а не нулевая позиция движка', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.ctl.seekTo(4);
    s.ctl.cancel();
    s.engine.setPosition(0, 10);
    const source = createProgressSource(s.ctl);
    expect(source.getSnapshot()).toEqual({ buffered: [], current: 4, duration: 10 });
    expect(s.ctl.getPosition().current).toBe(4);
    s.ctl.resume();
    s.engine.setPosition(5, 10);
    expect(s.ctl.getPosition().current).toBe(5);
  });
});
