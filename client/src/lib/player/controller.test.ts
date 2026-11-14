import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ids, pt, queue, setup, MemStorage, type Setup } from '@/test/player';
import { createLibraryStore } from '@/lib/store/library';
import { createMutations } from '@/lib/store/mutations';
import { makeTrack } from '@/test/factories';
import type { AudioSource } from './audio/types';
import { ERROR_ADVANCE_MS, PERSIST_INTERVAL_MS, TICK_MS, TRANSCODE_SEEK_DEBOUNCE_MS } from './controller';
import { STORAGE_KEY } from './engine';

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('запуск', () => {
  it('play: очередь и индекс, загрузка с автозапуском, метаданные; loading → playing', () => {
    const s = setup();
    s.ctl.play(s.library.get(2)!, queue(s));
    expect(s.ctl.state).toMatchObject({ index: 1, isPlaying: true, status: 'loading' });
    expect(s.engine.lastLoad).toEqual({
      opts: { autoplay: true, positionOffset: 0, startAt: 0 },
      src: { mode: 'direct', url: '/s/2' },
    });
    expect(s.engine.nowPlaying).toEqual({
      album: 'Album',
      artist: 'Artist',
      coverUrl: null,
      durationS: 10,
      title: 'T2',
    });
    s.engine.emit({ type: 'loading' });
    expect(s.ctl.state.status).toBe('loading');
    s.engine.emit({ type: 'playing' });
    expect(s.ctl.state).toMatchObject({ isPlaying: true, status: 'playing' });
  });

  it('сетевой трек: engine.load вызывается синхронно, до возврата из play (жест iOS)', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!);
    expect(s.engine.loads).toHaveLength(1);
  });

  it('асинхронный resolveStreamUrl: load после ответа, устаревший ответ отбрасывается', async () => {
    let release: (v: AudioSource) => void = () => undefined;
    const slow = new Promise<AudioSource>(r => (release = r));
    const s = setup({
      resolveStreamUrl: t => (t.id === 1 ? slow : { mode: 'direct', url: `/s/${t.id}` }),
    });
    s.ctl.play(s.library.get(1)!, queue(s));
    expect(s.engine.loads).toHaveLength(0);
    s.ctl.next(); // трек 2 — синхронно
    expect(s.engine.lastLoad?.src.url).toBe('/s/2');
    release({ mode: 'direct', url: '/s/1' });
    await flush();
    expect(s.engine.loads.map(l => l.src.url)).toEqual(['/s/2']);
  });

  it('трек вне переданной очереди ставится первым; очередь из одного трека', () => {
    const s = setup();
    s.ctl.play(pt(99), [pt(1), pt(2)]);
    expect(ids(s.ctl)).toEqual([99, 1, 2]);
    s.ctl.play(pt(5));
    expect(ids(s.ctl)).toEqual([5]);
  });

  it('shuffle при запуске: выбранный трек первым', () => {
    const s = setup();
    s.ctl.toggleShuffle();
    s.ctl.play(s.library.get(3)!, queue(s));
    expect(s.ctl.state.queue[0].id).toBe(3);
    expect(s.ctl.state.originalQueue?.map(t => t.id)).toEqual([1, 2, 3, 4]);
    expect(s.ctl.state.index).toBe(0);
  });

  it('ошибка построения адреса: состояние error (network), без падения', async () => {
    const s = setup({
      resolveStreamUrl: () => {
        throw new Error('no url');
      },
    });
    s.ctl.play(s.library.get(1)!);
    expect(s.ctl.state).toMatchObject({ error: { code: 'network' }, status: 'error' });
    expect(s.notify).toHaveBeenCalledOnce();
    const rejecting = setup({ resolveStreamUrl: () => Promise.reject(new Error('no url')) });
    rejecting.ctl.play(rejecting.library.get(1)!);
    await flush();
    expect(rejecting.ctl.state.status).toBe('error');
  });

  it('metadata: длительность неизвестна — 0, альбом пустой', () => {
    const s = setup({}, [pt(1, { album: null, durationMs: null })]);
    s.ctl.play(s.library.get(1)!);
    expect(s.engine.nowPlaying).toMatchObject({ album: '', durationS: 0 });
  });
});

describe('переходы', () => {
  it('конец трека → следующий доступный (недоступные пропускаются)', () => {
    const s = setup({}, [pt(1), pt(2, { status: 'adding' }), pt(3), pt(4)]);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'ended' });
    expect(s.ctl.state.index).toBe(2);
    expect(s.engine.lastLoad?.src.url).toBe('/s/3');
  });

  it('статус берётся из библиотеки в момент перехода, а не из снимка очереди', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.library.set(2, pt(2, { status: 'not_found' }));
    s.engine.emit({ type: 'ended' });
    expect(s.ctl.state.index).toBe(2);
  });

  it('конец очереди без повтора — остановка в начале трека', () => {
    const s = setup();
    s.ctl.play(s.library.get(4)!, queue(s));
    s.engine.emit({ type: 'ended' });
    expect(s.ctl.state).toMatchObject({ isPlaying: false, position: 0, status: 'paused' });
  });

  it('repeat one: тот же трек с начала; transcode — новая загрузка', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.ctl.cycleRepeat();
    s.ctl.cycleRepeat();
    expect(s.ctl.state.repeat).toBe('one');
    s.engine.emit({ type: 'ended' });
    expect(s.engine.seeks).toEqual([0]);
    expect(s.engine.playCalls).toBe(1);
    expect(s.ctl.state.index).toBe(0);

    const tr = setup({}, [pt(1, { playback: 'transcode' }), pt(2)]);
    tr.ctl.play(tr.library.get(1)!, queue(tr));
    tr.ctl.cycleRepeat();
    tr.ctl.cycleRepeat();
    tr.engine.emit({ type: 'ended' });
    expect(tr.engine.loads).toHaveLength(2);
    expect(tr.engine.seeks).toEqual([]);
  });

  it('repeat all: после последнего — первый; единственный доступный трек играет заново', () => {
    const s = setup();
    s.ctl.play(s.library.get(4)!, queue(s));
    s.ctl.cycleRepeat();
    expect(s.ctl.state.repeat).toBe('all');
    s.engine.emit({ type: 'ended' });
    expect(s.ctl.state.index).toBe(0);

    const one = setup({}, [pt(1)]);
    one.ctl.play(one.library.get(1)!);
    one.ctl.cycleRepeat();
    one.engine.emit({ type: 'ended' });
    expect(one.engine.seeks).toEqual([0]);
  });

  it('cycleRepeat: off → all → one → off', () => {
    const s = setup();
    const seen = [s.ctl.state.repeat];
    for (let i = 0; i < 3; i++) {
      s.ctl.cycleRepeat();
      seen.push(s.ctl.state.repeat);
    }
    expect(seen).toEqual(['off', 'all', 'one', 'off']);
  });

  it('shuffle включить/выключить сохраняет текущий трек', () => {
    const s = setup();
    s.ctl.play(s.library.get(3)!, queue(s));
    s.ctl.toggleShuffle();
    expect(s.ctl.state.shuffle).toBe(true);
    expect(s.ctl.state.queue[s.ctl.state.index].id).toBe(3);
    expect(ids(s.ctl).slice().sort()).toEqual([1, 2, 3, 4]);
    s.ctl.toggleShuffle();
    expect(ids(s.ctl)).toEqual([1, 2, 3, 4]);
    expect(s.ctl.state.index).toBe(2);
    expect(s.engine.loads).toHaveLength(1); // трек не перезапускался
  });

  it('previous: после 3 с — в начало трека, иначе предыдущий; на первом треке — в начало', () => {
    const s = setup();
    s.ctl.play(s.library.get(3)!, queue(s));
    s.engine.setPosition(1);
    s.ctl.previous();
    expect(s.ctl.state.index).toBe(1);
    s.engine.setPosition(3.5);
    s.ctl.previous();
    expect(s.ctl.state.index).toBe(1);
    expect(s.engine.seeks).toEqual([0]);
    s.ctl.previous();
    expect(s.ctl.state.index).toBe(0);
    s.engine.setPosition(0.5);
    s.ctl.previous();
    expect(s.ctl.state.index).toBe(0);
    expect(s.engine.seeks).toEqual([0, 0]);
  });

  it('next на последнем треке ничего не делает; hasNext отражает доступность', () => {
    const s = setup();
    s.ctl.play(s.library.get(4)!, queue(s));
    expect(s.ctl.hasNext()).toBe(false);
    s.ctl.next();
    expect(s.engine.loads).toHaveLength(1);
    s.ctl.playIndex(0);
    expect(s.ctl.hasNext()).toBe(true);
  });

  it('playIndex вне очереди игнорируется', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.ctl.playIndex(42);
    expect(s.ctl.state.index).toBe(0);
  });
});

describe('удаление трека из библиотеки', () => {
  it('следующий трек удалён — пропускается без ошибки', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.library.delete(2);
    s.engine.emit({ type: 'ended' });
    expect(s.ctl.state).toMatchObject({ index: 2, status: 'loading' });
    expect(s.ctl.state.error).toBeUndefined();
    expect(s.notify).not.toHaveBeenCalled();
  });

  it('до загрузки библиотеки снимкам в очереди верим', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.settings.ready = false;
    s.library.clear();
    expect(s.ctl.hasNext()).toBe(true);
    s.ctl.next();
    expect(s.engine.lastLoad?.src.url).toBe('/s/2');
  });
});

describe('ошибки потока', () => {
  it('error → расшифровка HEAD → состояние error с кодом → через 2 с следующий трек', async () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ code: 'media', type: 'error' });
    expect(s.probe).toHaveBeenCalledWith({ mode: 'direct', url: '/s/1' });
    await flush();
    expect(s.ctl.state).toMatchObject({ error: { code: 'no_peers' }, isPlaying: false, status: 'error' });
    expect(s.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { code: 'no_peers' });
    expect(s.engine.loads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ERROR_ADVANCE_MS);
    expect(s.ctl.state).toMatchObject({ index: 1, status: 'loading' });
    expect(s.engine.lastLoad?.src.url).toBe('/s/2');
  });

  it('на последнем треке — остановка на ошибке, без перехода', async () => {
    const s = setup();
    s.ctl.play(s.library.get(4)!, queue(s));
    s.engine.emit({ code: 'media', type: 'error' });
    await vi.advanceTimersByTimeAsync(ERROR_ADVANCE_MS + 100);
    expect(s.ctl.state).toMatchObject({ index: 3, status: 'error' });
    expect(s.engine.loads).toHaveLength(1);
  });

  it('автопереход не срабатывает, если пользователь уже что-то сделал', async () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ code: 'media', type: 'error' });
    await flush();
    s.ctl.playIndex(2);
    await vi.advanceTimersByTimeAsync(ERROR_ADVANCE_MS * 2);
    expect(s.ctl.state.index).toBe(2);
    expect(s.engine.loads.map(l => l.src.url)).toEqual(['/s/1', '/s/3']);
  });

  it('ошибка устаревшего трека и ошибка после отмены игнорируются', async () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ code: 'media', type: 'error' });
    s.ctl.next(); // пока идёт расшифровка, играет уже другой трек
    await flush();
    expect(s.ctl.state.status).toBe('loading');
    s.ctl.cancel();
    s.engine.emit({ code: 'media', type: 'error' });
    expect(s.probe).toHaveBeenCalledTimes(1);
  });

  it('расшифровка устаревшей загрузки того же трека не портит новую', async () => {
    let finish: (e: { code: string }) => void = () => undefined;
    const s = setup({ probe: () => new Promise(r => (finish = r)) });
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ code: 'media', type: 'error' });
    s.ctl.playIndex(0); // тот же трек загружен заново, пока идёт HEAD
    finish({ code: 'no_peers' });
    await flush();
    expect(s.ctl.state.status).toBe('loading');
    expect(s.notify).not.toHaveBeenCalled();
  });

  it('до первой загрузки ошибка движка не вызывает расшифровку', () => {
    const s = setup();
    s.engine.emit({ code: 'media', type: 'error' });
    expect(s.probe).not.toHaveBeenCalled();
  });
});

describe('статус и события движка', () => {
  it('waiting → buffering, paused → paused, но не поверх error/idle', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!);
    s.engine.emit({ type: 'playing' });
    s.engine.emit({ type: 'waiting' });
    expect(s.ctl.state.status).toBe('buffering');
    s.engine.emit({ type: 'paused' });
    expect(s.ctl.state).toMatchObject({ isPlaying: false, status: 'paused' });
    s.ctl.cancel();
    s.engine.emit({ type: 'paused' });
    expect(s.ctl.state.status).toBe('idle');
  });

  it('события без загруженного трека игнорируются', () => {
    const s = setup();
    for (const type of ['loading', 'playing', 'waiting', 'paused'] as const) s.engine.emit({ type });
    expect(s.ctl.state.status).toBe('idle');
  });
});

describe('pause / resume', () => {
  it('pause и resume загруженного трека; отказ play() возвращает паузу', async () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!);
    s.ctl.pause();
    expect(s.engine.paused).toBe(true);
    s.engine.emit({ type: 'paused' });
    s.ctl.resume();
    expect(s.ctl.state.isPlaying).toBe(true);
    expect(s.engine.playCalls).toBe(1);
    s.engine.playError = new Error('blocked');
    s.engine.emit({ type: 'paused' });
    s.ctl.resume();
    await flush();
    expect(s.ctl.state.isPlaying).toBe(false);
  });

  it('togglePlayPause переключает намерение', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!);
    s.ctl.togglePlayPause();
    expect(s.engine.paused).toBe(true);
    s.engine.emit({ type: 'paused' });
    s.ctl.togglePlayPause();
    expect(s.engine.playCalls).toBe(1);
  });

  it('resume без трека ничего не делает', () => {
    const s = setup();
    s.ctl.resume();
    expect(s.engine.loads).toEqual([]);
  });

  it('resume после cancel загружает трек заново с сохранённой позиции', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!);
    s.ctl.seekTo(4);
    s.ctl.cancel();
    expect(s.engine.unloads).toBe(1);
    expect(s.engine.nowPlaying).toBeNull();
    expect(s.ctl.state.status).toBe('idle');
    s.ctl.resume();
    expect(s.engine.lastLoad?.opts).toMatchObject({ autoplay: true, startAt: 4 });
    expect(s.ctl.state.position).toBe(4);
  });
});

describe('перемотка', () => {
  it('обычный трек: seek движка, позиция в состоянии; значение ограничивается длительностью', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!);
    s.ctl.seekTo(3);
    expect(s.engine.seeks).toEqual([3]);
    expect(s.ctl.state.position).toBe(3);
    s.ctl.seekTo(500);
    expect(s.engine.seeks.at(-1)).toBe(10);
    s.ctl.seekTo(-4);
    expect(s.engine.seeks.at(-1)).toBe(0);
  });

  it('перекодируемый трек: новый адрес ?t=, смещение позиции, играет, если играл', () => {
    const s = setup({}, [pt(1, { playback: 'transcode' })]);
    s.ctl.play(s.library.get(1)!);
    expect(s.engine.lastLoad?.src).toEqual({ mode: 'transcode', url: '/s/1' });
    s.ctl.seekTo(3);
    // позиция в интерфейсе меняется сразу, поток открывается по паузе в движении
    expect(s.ctl.state.position).toBe(3);
    expect(s.ctl.getPosition().current).toBe(3);
    expect(s.engine.loads).toHaveLength(1);
    vi.advanceTimersByTime(TRANSCODE_SEEK_DEBOUNCE_MS);
    expect(s.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1 }), 3);
    expect(s.engine.lastLoad).toEqual({
      opts: { autoplay: true, positionOffset: 3, startAt: 0 },
      src: { mode: 'transcode', url: '/s/1?t=3' },
    });
    expect(s.engine.seeks).toEqual([]);
    expect(s.engine.position.current).toBe(3);
    // после открытия потока позиция снова читается у движка
    s.engine.setPosition(3.5);
    expect(s.ctl.getPosition().current).toBe(3.5);
    // на паузе: поток загружается, но не запускается
    s.engine.emit({ type: 'paused' });
    s.ctl.seekTo(1);
    vi.advanceTimersByTime(TRANSCODE_SEEK_DEBOUNCE_MS);
    expect(s.engine.lastLoad?.opts.autoplay).toBe(false);
  });

  it('перетаскивание ползунка на перекодируемом треке открывает один поток — с последней позиции', () => {
    const s = setup({}, [pt(1, { playback: 'transcode' })]);
    s.ctl.play(s.library.get(1)!);
    for (const t of [1, 2, 3, 4]) {
      s.ctl.seekTo(t);
      vi.advanceTimersByTime(TRANSCODE_SEEK_DEBOUNCE_MS / 4);
    }
    expect(s.engine.loads).toHaveLength(1);
    vi.advanceTimersByTime(TRANSCODE_SEEK_DEBOUNCE_MS);
    expect(s.engine.loads).toHaveLength(2);
    expect(s.engine.lastLoad?.opts.positionOffset).toBe(4);
  });

  it('отложенная перемотка отменяется сменой трека и отменой загрузки', () => {
    const s = setup({}, [pt(1, { playback: 'transcode' }), pt(2)]);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.ctl.seekTo(3);
    s.ctl.next();
    vi.advanceTimersByTime(TRANSCODE_SEEK_DEBOUNCE_MS * 2);
    expect(s.engine.loads.map(l => l.src.url)).toEqual(['/s/1', '/s/2']);
    expect(s.ctl.getPosition().current).not.toBe(3);
    s.ctl.playIndex(0);
    s.ctl.seekTo(2);
    s.ctl.cancel();
    vi.advanceTimersByTime(TRANSCODE_SEEK_DEBOUNCE_MS * 2);
    expect(s.engine.loads).toHaveLength(3);
  });

  it('до загрузки перемотка только запоминает позицию', () => {
    const s = setup();
    s.ctl.seekTo(5);
    expect(s.engine.seeks).toEqual([]);
    expect(s.ctl.state.position).toBe(5);
    expect(s.ctl.positionNow()).toBe(5);
  });

  it('positionNow читает позицию у движка', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!);
    s.engine.setPosition(6.5);
    expect(s.ctl.positionNow()).toBe(6.5);
  });
});

describe('громкость', () => {
  it('setVolume/toggleMute передают в движок 0–1; громкость > 0 снимает mute', () => {
    const s = setup();
    s.ctl.setVolume(40);
    expect(s.engine.volume).toBe(0.4);
    s.ctl.toggleMute();
    expect(s.engine.volume).toBe(0);
    expect(s.ctl.state.muted).toBe(true);
    s.ctl.setVolume(60);
    expect(s.ctl.state.muted).toBe(false);
    expect(s.engine.volume).toBe(0.6);
    s.ctl.setVolume(250);
    expect(s.ctl.state.volume).toBe(100);
    s.ctl.setVolume(0);
    expect(s.engine.volume).toBe(0);
  });
});

describe('очередь', () => {
  it('enqueue, playNext, remove, move', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.ctl.enqueue(pt(10));
    s.ctl.playNext(pt(11));
    expect(ids(s.ctl)).toEqual([1, 11, 2, 3, 4, 10]);
    s.ctl.moveInQueue(5, 2);
    expect(ids(s.ctl)).toEqual([1, 11, 10, 2, 3, 4]);
    s.ctl.moveInQueue(0, 3); // текущий не двигается
    expect(ids(s.ctl)).toEqual([1, 11, 10, 2, 3, 4]);
    s.ctl.removeFromQueue(2);
    expect(ids(s.ctl)).toEqual([1, 11, 2, 3, 4]);
    s.ctl.removeFromQueue(0); // текущий не удаляется
    expect(ids(s.ctl)).toHaveLength(5);
  });
});

describe('команды нативного движка: advanced и remote', () => {
  it('advanced сдвигает очередь без повторного load и отдаёт движку новый «следующий»', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    expect(s.engine.preloaded?.url).toBe('/s/2');
    s.engine.emit({ type: 'advanced' });
    expect(s.ctl.state).toMatchObject({ index: 1, status: 'loading' });
    expect(s.engine.loads).toHaveLength(1);
    expect(s.engine.preloaded?.url).toBe('/s/3');
    // дальше обычный ход: playing, конец → следующий трек грузится как обычно
    s.engine.emit({ type: 'playing' });
    expect(s.ctl.state.status).toBe('playing');
  });

  it('advanced на последнем треке игнорируется', () => {
    const s = setup();
    s.ctl.play(s.library.get(4)!, queue(s));
    s.engine.emit({ type: 'advanced' });
    expect(s.ctl.state.index).toBe(3);
  });

  it('remote: next ведёт себя как кнопка «Следующий»', () => {
    const viaButton = setup();
    viaButton.ctl.play(viaButton.library.get(1)!, queue(viaButton));
    viaButton.ctl.next();
    const viaRemote = setup();
    viaRemote.ctl.play(viaRemote.library.get(1)!, queue(viaRemote));
    viaRemote.engine.emit({ action: 'next', type: 'remote' });
    expect(viaRemote.ctl.state).toEqual(viaButton.ctl.state);
    expect(viaRemote.engine.lastLoad).toEqual(viaButton.engine.lastLoad);
  });

  it('remote: play/pause/previous/seekto/seekforward/seekbackward', () => {
    const s = setup();
    s.ctl.play(s.library.get(2)!, queue(s));
    s.engine.emit({ action: 'pause', type: 'remote' });
    expect(s.engine.paused).toBe(true);
    s.engine.emit({ type: 'paused' });
    s.engine.emit({ action: 'play', type: 'remote' });
    expect(s.engine.playCalls).toBe(1);
    s.engine.setPosition(1);
    s.engine.emit({ action: 'previous', type: 'remote' });
    expect(s.ctl.state.index).toBe(0);
    s.engine.emit({ action: 'seekto', seekTo: 7, type: 'remote' });
    expect(s.engine.seeks.at(-1)).toBe(7);
    s.engine.emit({ action: 'seekto', type: 'remote' }); // без позиции — ничего
    expect(s.engine.seeks).toHaveLength(1);
    s.engine.setPosition(4);
    s.engine.emit({ action: 'seekforward', type: 'remote' });
    expect(s.engine.seeks.at(-1)).toBe(9);
    s.engine.setPosition(4);
    s.engine.emit({ action: 'seekbackward', offset: 3, type: 'remote' });
    expect(s.engine.seeks.at(-1)).toBe(1);
  });
});

describe('библиотека меняется во время игры', () => {
  it('restore: недоступный текущий трек → error track_not_playable без таймера перехода; found → играет', () => {
    const storage = new MemStorage();
    const first = setup({}, [pt(1), pt(2)], storage);
    first.ctl.play(first.library.get(1)!, queue(first));
    first.ctl.seekTo(4);
    first.ctl.pause();
    first.ctl.persist();
    first.ctl.destroy();

    const s = setup({}, [pt(1, { status: 'adding' }), pt(2)], storage);
    s.ctl.resume();
    expect(s.ctl.state).toMatchObject({ error: { code: 'track_not_playable' }, status: 'error' });
    expect(s.engine.loads).toEqual([]);
    vi.advanceTimersByTime(ERROR_ADVANCE_MS * 2);
    expect(s.engine.loads).toEqual([]);
    s.library.set(1, pt(1, { status: 'found' }));
    s.changeLibrary();
    expect(s.engine.lastLoad?.src.url).toBe('/s/1');
    expect(s.engine.lastLoad?.opts.startAt).toBe(4);
    expect(s.ctl.state.status).toBe('loading');
  });

  it('следующий трек стал недоступен — движку сообщают актуальный «следующий»', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    expect(s.engine.preloaded?.url).toBe('/s/2');
    s.library.set(2, pt(2, { status: 'not_found' }));
    s.changeLibrary();
    expect(s.engine.preloaded?.url).toBe('/s/3');
    s.changeLibrary(); // без изменений — повторно не шлётся
    expect(s.engine.preloads).toHaveLength(2);
    s.library.delete(3);
    s.library.delete(4);
    s.changeLibrary();
    expect(s.engine.preloaded).toBeNull();
  });

  it('асинхронный адрес следующего трека доходит до движка, устаревший — нет', async () => {
    const pending: ((v: AudioSource) => void)[] = [];
    const s = setup({
      resolveStreamUrl: (t, start) =>
        start === 0 && t.id !== 1
          ? new Promise<AudioSource>(r => pending.push(r))
          : { mode: 'direct', url: `/s/${t.id}` },
    });
    s.ctl.play(s.library.get(1)!, queue(s));
    expect(pending).toHaveLength(1);
    s.library.set(2, pt(2, { status: 'not_found' }));
    s.changeLibrary(); // «следующий» теперь 3
    pending[0]({ mode: 'direct', url: '/s/2' });
    pending[1]({ mode: 'direct', url: '/s/3' });
    await flush();
    expect(s.engine.preloads.map(p => p?.url)).toEqual(['/s/3']);
  });

  it('ошибка построения адреса следующего трека не ломает воспроизведение', () => {
    const s = setup({
      resolveStreamUrl: t => {
        if (t.id === 2) throw new Error('boom');
        return { mode: 'direct', url: `/s/${t.id}` };
      },
    });
    s.ctl.play(s.library.get(1)!, queue(s));
    expect(s.ctl.state.status).toBe('loading');
    expect(s.engine.preloaded).toBeNull();
  });
});

describe('сохранение и восстановление', () => {
  it('очередь и настройки пишутся сразу, позиция при игре — не чаще раза в 2 с', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    const afterPlay = s.storage.writes;
    expect(afterPlay).toBeGreaterThan(0);
    s.engine.emit({ type: 'playing' });
    s.engine.setPosition(1, 10);
    const base = s.storage.writes;
    // 8 секунд тиков по 250 мс
    for (let i = 0; i < 8000 / TICK_MS; i++) vi.advanceTimersByTime(TICK_MS);
    const writes = s.storage.writes - base;
    expect(writes).toBeGreaterThanOrEqual(3);
    expect(writes).toBeLessThanOrEqual(8000 / PERSIST_INTERVAL_MS + 1);
    s.ctl.setVolume(20);
    expect(s.storage.writes - base).toBe(writes + 1);
  });

  it('пауза сохраняет позицию сразу; после «перезапуска» — пауза на той же позиции', () => {
    const storage = new MemStorage();
    const s = setup({}, undefined, storage);
    s.ctl.play(s.library.get(2)!, queue(s));
    s.engine.emit({ type: 'playing' });
    s.ctl.setVolume(40);
    s.ctl.cycleRepeat();
    s.engine.setPosition(6.5);
    s.ctl.pause();
    s.engine.emit({ type: 'paused' });
    s.ctl.destroy();

    const restored = setup({}, undefined, storage);
    expect(restored.ctl.state).toMatchObject({
      index: 1,
      isPlaying: false,
      position: 6.5,
      repeat: 'all',
      status: 'paused',
      volume: 40,
    });
    expect(restored.engine.volume).toBe(0.4);
    expect(restored.engine.loads).toEqual([]);
    restored.ctl.resume();
    expect(restored.engine.lastLoad?.opts).toMatchObject({ autoplay: true, startAt: 6.5 });
  });

  it('повреждённое значение и недоступное хранилище игнорируются', () => {
    const bad = new MemStorage();
    bad.data.set(STORAGE_KEY, '{oops');
    expect(setup({}, undefined, bad).ctl.state.queue).toEqual([]);
    const denied = new MemStorage();
    denied.fail = true;
    const s = setup({}, undefined, denied);
    s.ctl.play(s.library.get(1)!);
    s.ctl.persist(); // не бросает
    expect(s.ctl.state.index).toBe(0);
  });

  it('пустое состояние с громкостью по умолчанию не пишется; без хранилища — без ошибок', () => {
    const s = setup();
    s.ctl.persist();
    expect(s.storage.writes).toBe(0);
    const noStorage = setup({ storage: undefined });
    noStorage.ctl.play(noStorage.library.get(1)!);
    noStorage.ctl.persist();
  });
});

describe('прослушивание', () => {
  function listenFor(s: Setup, from: number, to: number, duration = 20) {
    for (let p = from; p <= to; p += TICK_MS / 1000) {
      s.engine.setPosition(p, duration);
      vi.advanceTimersByTime(TICK_MS);
    }
  }

  it('played отправляется один раз после порога; перемотка вперёд не засчитывается', () => {
    const s = setup({}, [pt(1, { durationMs: 20_000 }), pt(2)]);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    listenFor(s, 0, 4); // меньше половины (10 с)
    expect(s.recordPlay).not.toHaveBeenCalled();
    listenFor(s, 18, 19); // прыжок вперёд: время не копится
    expect(s.recordPlay).not.toHaveBeenCalled();
    listenFor(s, 4, 11);
    expect(s.recordPlay).toHaveBeenCalledOnce();
    expect(s.recordPlay).toHaveBeenCalledWith(1);
    listenFor(s, 11, 19);
    expect(s.recordPlay).toHaveBeenCalledOnce();
  });

  it('новый проход того же трека (конец → повтор) считается заново', () => {
    const s = setup({}, [pt(1, { durationMs: 8000 })]);
    s.ctl.play(s.library.get(1)!);
    s.engine.emit({ type: 'playing' });
    listenFor(s, 0, 5, 8);
    expect(s.recordPlay).toHaveBeenCalledTimes(1);
    s.ctl.cycleRepeat();
    s.ctl.cycleRepeat();
    s.engine.emit({ type: 'ended' });
    listenFor(s, 0, 5, 8);
    expect(s.recordPlay).toHaveBeenCalledTimes(2);
  });

  it('длительность берётся у движка, если у трека её нет; отказ записи не падает', async () => {
    const s = setup({ recordPlay: vi.fn(async () => Promise.reject(new Error('offline'))) }, [
      pt(1, { durationMs: null }),
    ]);
    s.ctl.play(s.library.get(1)!);
    s.engine.emit({ type: 'playing' });
    listenFor(s, 0, 4, 6);
    await flush();
    expect(s.deps.recordPlay).toHaveBeenCalledOnce();
  });

  it('без сети прослушивание уходит в outbox (через мутации шага 37)', async () => {
    const store = createLibraryStore();
    store.getState().hydrate({
      albums: [],
      artists: [],
      playlistTracks: [],
      playlists: [],
      tracks: [makeTrack({ id: 1, play_count: 2 })],
    });
    const outboxAdd = vi.fn(async () => undefined);
    const mutations = createMutations({
      db: { outboxAdd } as never,
      isOnline: () => false,
      now: () => Date.now(),
      postPlayed: vi.fn(),
      requestSync: vi.fn(),
      store,
    });
    const s = setup({ recordPlay: id => mutations.recordPlay(id) }, [pt(1, { durationMs: 8000 })]);
    s.ctl.play(s.library.get(1)!);
    s.engine.emit({ type: 'playing' });
    listenFor(s, 0, 5, 8);
    await flush();
    expect(outboxAdd).toHaveBeenCalledOnce();
    expect(store.getState().tracks.get(1)?.play_count).toBe(3);
  });
});

describe('предзагрузка (prefetch)', () => {
  const durations = { durationMs: 100_000 };

  it('включена в настройках: следующий трек `found` предзагружается один раз', () => {
    const s = setup({}, [pt(1, durations), pt(2, { status: 'found' })]);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    s.engine.setPosition(5, 100);
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(s.prefetchTrack).toHaveBeenCalledOnce();
    expect(s.prefetchTrack).toHaveBeenCalledWith(2);
  });

  it('выключена: только за 30 с до конца', () => {
    const s = setup({}, [pt(1, durations), pt(2)]);
    s.settings.prefetch = false;
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    s.engine.setPosition(10, 100);
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(s.prefetchTrack).not.toHaveBeenCalled();
    s.engine.setPosition(75, 100);
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(s.prefetchTrack).toHaveBeenCalledOnce();
  });

  it('при новом запуске предзагрузка следующего повторяется (один раз на запуск)', () => {
    const s = setup({}, [pt(1, durations), pt(2)]);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    s.engine.setPosition(5, 100);
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(s.prefetchTrack).toHaveBeenCalledTimes(1);
    s.ctl.playIndex(0);
    s.engine.emit({ type: 'playing' });
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(s.prefetchTrack).toHaveBeenCalledTimes(2);
  });

  it('следующий `ready` (файл уже на диске), недоступный или удалённый — не предзагружается', () => {
    const ready = setup({}, [pt(1, durations), pt(2, { status: 'ready' })]);
    ready.ctl.play(ready.library.get(1)!, queue(ready));
    ready.engine.emit({ type: 'playing' });
    ready.engine.setPosition(5, 100);
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(ready.prefetchTrack).not.toHaveBeenCalled();

    const gone = setup({}, [pt(1, durations), pt(2)]);
    gone.ctl.play(gone.library.get(1)!, queue(gone));
    gone.library.delete(2);
    gone.engine.emit({ type: 'playing' });
    gone.engine.setPosition(5, 100);
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(gone.prefetchTrack).not.toHaveBeenCalled();
  });

  it('не предзагружает на паузе, при неизвестной длительности и на последнем треке; ошибка запроса глотается', async () => {
    const s = setup({ prefetchTrack: vi.fn(async () => Promise.reject(new Error('x'))) }, [pt(1, durations), pt(2)]);
    s.ctl.play(s.library.get(2)!, queue(s)); // последний
    s.engine.emit({ type: 'playing' });
    s.engine.setPosition(5, 100);
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(s.deps.prefetchTrack).not.toHaveBeenCalled();
    s.ctl.playIndex(0);
    s.engine.setPosition(5, 0);
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(s.deps.prefetchTrack).not.toHaveBeenCalled();
    s.engine.setPosition(5, 100);
    vi.advanceTimersByTime(TICK_MS * 2);
    await flush();
    expect(s.deps.prefetchTrack).toHaveBeenCalledOnce();
  });
});

describe('опрос позиции', () => {
  it('таймер работает только пока играет; длительность из движка попадает в состояние один раз', () => {
    const s = setup({}, [pt(1, { durationMs: null })]);
    s.ctl.play(s.library.get(1)!);
    s.engine.setPosition(1, 187.4);
    vi.advanceTimersByTime(TICK_MS);
    expect(s.ctl.state.duration).toBe(187.4);
    const listener = vi.fn();
    s.ctl.store.subscribe(listener);
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(listener).not.toHaveBeenCalled(); // позиция в общий store не пишется
    s.engine.emit({ type: 'paused' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tick без трека или до загрузки ничего не делает', () => {
    const s = setup();
    s.ctl.tick();
    s.ctl.play(s.library.get(1)!);
    s.ctl.cancel();
    s.ctl.tick();
    expect(s.recordPlay).not.toHaveBeenCalled();
  });
});

describe('destroy', () => {
  it('останавливает звук, таймеры и подписки', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    s.ctl.destroy();
    expect(s.engine.unloads).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.libListeners.size).toBe(0);
    s.engine.emit({ type: 'ended' }); // события движка больше не слушаются
    expect(s.engine.loads).toHaveLength(1);
    // состояние разрушенного контроллера не запускает таймеры и не пишет в хранилище
    const writes = s.storage.writes;
    s.ctl.seekTo(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.storage.writes).toBe(writes);
  });
});

describe('смена источника трека (reloadTrack)', () => {
  it('играющий трек: поток открывается заново с текущей позиции, играет дальше', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    s.engine.setPosition(42, 100);
    s.ctl.reloadTrack(1);
    expect(s.engine.loads).toHaveLength(2);
    expect(s.engine.lastLoad?.opts).toMatchObject({ autoplay: true, startAt: 42 });
  });

  it('на паузе: позиция сохраняется, автозапуска нет', () => {
    const s = setup();
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    s.ctl.pause();
    s.engine.emit({ type: 'paused' });
    s.engine.setPosition(7, 100);
    s.ctl.reloadTrack(1);
    expect(s.engine.lastLoad?.opts).toMatchObject({ autoplay: false, startAt: 7 });
  });

  it('перекодируемый трек: позиция уходит в смещение запроса', () => {
    const s = setup({}, [pt(1, { playback: 'transcode' }), pt(2)]);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    s.engine.setPosition(12, 100);
    s.ctl.reloadTrack(1);
    expect(s.engine.lastLoad?.opts).toMatchObject({ positionOffset: 12, startAt: 0 });
  });

  it('другой трек или пустой плеер — ничего не происходит', () => {
    const s = setup();
    s.ctl.reloadTrack(1);
    expect(s.engine.loads).toHaveLength(0);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.ctl.reloadTrack(2);
    expect(s.engine.loads).toHaveLength(1);
  });
});
