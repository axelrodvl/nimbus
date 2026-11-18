import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAudio, FakeMediaMetadata, FakeMediaSession } from '@/test/fake-audio';
import { createAudioEngine } from './index';
import type { AudioEvent, AudioSource } from './types';
import { createAudioElement, createWebAudioEngine, sharedWebAudioEngine } from './web-engine';

const src = (id: number, mode: AudioSource['mode'] = 'direct'): AudioSource => ({ mode, url: `/s/${id}` });
const META = { album: 'Album', artist: 'Artist', coverUrl: 'http://c/1.jpg', durationS: 5, title: 'Song' };

function setup() {
  const audio = new FakeAudio();
  const session = new FakeMediaSession();
  const engine = createWebAudioEngine({ audio: audio.asElement(), mediaSession: session.asSession() });
  const events: AudioEvent[] = [];
  engine.on(e => events.push(e));
  return { audio, engine, events, session };
}
const types = (events: AudioEvent[]) => events.map(e => e.type);

beforeEach(() => {
  vi.stubGlobal('MediaMetadata', FakeMediaMetadata);
});
afterEach(() => vi.useRealTimers());

describe('load', () => {
  it('синхронно выставляет src и вызывает play() в том же тике при autoplay', () => {
    const { audio, engine } = setup();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    // Без await: iOS разрешает запуск только внутри обработчика жеста.
    expect(audio.getAttribute('src')).toBe('/s/1');
    expect(audio.playCalls).toBe(1);
  });

  it('без autoplay play() не вызывается, «загрузкой» плеер не притворяется', () => {
    const { audio, engine, events, session } = setup();
    engine.load(src(1), { autoplay: false, startAt: 0 });
    expect(audio.playCalls).toBe(0);
    audio.fire('loadstart'); // элемент на паузе — это не подключение к раздаче
    expect(events).toEqual([]);
    expect(session.playbackState).toBe('paused');
  });

  it('AbortError (загрузку заменили) молчит, NotAllowedError — пауза', async () => {
    const { audio, engine, events } = setup();
    audio.playError = new DOMException('replaced', 'AbortError');
    engine.load(src(1), { autoplay: true, startAt: 0 });
    await Promise.resolve();
    expect(events).toEqual([]);
    audio.playError = new DOMException('blocked', 'NotAllowedError');
    engine.load(src(2), { autoplay: true, startAt: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(types(events)).toEqual(['paused']);
  });

  it('позиция начала применяется после loadedmetadata', () => {
    const { audio, engine } = setup();
    engine.load(src(1), { autoplay: false, startAt: 42 });
    expect(audio.currentTime).toBe(0);
    audio.fire('loadedmetadata');
    expect(audio.currentTime).toBe(42);
    audio.currentTime = 5;
    audio.fire('loadedmetadata');
    expect(audio.currentTime).toBe(5);
  });
});

describe('события <audio> → AudioEvent', () => {
  it('loadstart/playing/pause/ended/error', () => {
    const { audio, engine, events } = setup();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.fire('loadstart');
    audio.fire('playing');
    audio.paused = true;
    audio.fire('pause');
    audio.fire('error');
    audio.ended = true;
    audio.fire('ended');
    expect(events).toEqual([
      { type: 'loading' },
      { type: 'playing' },
      { interrupted: true, type: 'paused' },
      { code: 'media', type: 'error' },
      { type: 'ended' },
    ]);
  });

  it('pause в конце трека (ended) не считается паузой', () => {
    const { audio, engine, events } = setup();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.ended = true;
    audio.fire('pause');
    expect(events).toEqual([]);
  });

  it('waiting/stalled — только если данных реально нет (iOS шлёт stalled и при нормальной игре)', () => {
    const { audio, engine, events } = setup();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.readyState = 4;
    audio.fire('stalled');
    expect(events).toEqual([]);
    audio.readyState = 1;
    audio.fire('waiting');
    audio.fire('stalled');
    expect(types(events)).toEqual(['waiting']); // повтор не шлётся
  });

  it('timeupdate при идущем времени снимает «буферизацию» без playing/canplay', () => {
    const { audio, engine, events } = setup();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.readyState = 1;
    audio.fire('waiting');
    audio.readyState = 4;
    audio.fire('timeupdate');
    audio.fire('timeupdate');
    expect(types(events)).toEqual(['waiting', 'playing']); // и не спамит playing каждый тик
  });

  it('canplay → playing, если не на паузе', () => {
    const { audio, engine, events } = setup();
    engine.load(src(1), { autoplay: false, startAt: 0 });
    audio.paused = true;
    audio.fire('canplay');
    expect(events).toEqual([]);
    audio.paused = false;
    audio.fire('canplay');
    expect(types(events)).toEqual(['playing']);
  });

  it('устаревшие события предыдущего источника отбрасываются', () => {
    const { audio, engine, events } = setup();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    engine.unload();
    expect(audio.getAttribute('src')).toBeNull();
    for (const name of [
      'loadstart',
      'playing',
      'canplay',
      'pause',
      'ended',
      'error',
      'waiting',
      'timeupdate',
      'loadedmetadata',
    ]) {
      audio.fire(name);
    }
    expect(events).toEqual([]);
    // Источник заменили вне движка — события чужого src тоже не наши.
    engine.load(src(2), { autoplay: true, startAt: 0 });
    audio.setAttribute('src', '/s/other');
    audio.fire('error');
    expect(events).toEqual([]);
  });

  it('события до первой загрузки игнорируются', () => {
    const { audio, events } = setup();
    audio.fire('error');
    audio.fire('playing');
    expect(events).toEqual([]);
  });
});

describe('позиция', () => {
  it('direct: время элемента, длительность и буфер', () => {
    const { audio, engine } = setup();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.currentTime = 2.5;
    audio.duration = 5;
    audio.ranges = [[0, 4]];
    expect(engine.getPosition()).toEqual({ buffered: [[0, 4]], current: 2.5, duration: 5 });
  });

  it('длительность неизвестна — берётся у трека (setNowPlaying)', () => {
    const { audio, engine } = setup();
    engine.setNowPlaying(META);
    engine.load(src(1), { autoplay: false, startAt: 0 });
    audio.duration = Number.POSITIVE_INFINITY;
    expect(engine.getPosition().duration).toBe(5);
  });

  it('transcode: позиция = смещение + currentTime, длительность трека, буфера нет; startAt игнорируется', () => {
    const { audio, engine } = setup();
    engine.setNowPlaying(META);
    engine.load(src(1, 'transcode'), { autoplay: true, positionOffset: 3, startAt: 3 });
    audio.fire('loadedmetadata');
    expect(audio.currentTime).toBe(0);
    audio.currentTime = 1.5;
    audio.ranges = [[0, 1]];
    expect(engine.getPosition()).toEqual({ buffered: [], current: 4.5, duration: 5 });
  });

  it('transcode без длительности трека: смещение + длительность потока', () => {
    const { audio, engine } = setup();
    engine.load(src(1, 'transcode'), { autoplay: true, positionOffset: 3, startAt: 0 });
    audio.duration = 2;
    expect(engine.getPosition().duration).toBe(5);
  });

  it('до загрузки — позиция отложенной перемотки', () => {
    const { engine } = setup();
    engine.seek(12);
    expect(engine.getPosition()).toEqual({ buffered: [], current: 12, duration: 0 });
  });

  it('seek загруженного трека двигает currentTime', () => {
    const { audio, engine } = setup();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    engine.seek(7);
    expect(audio.currentTime).toBe(7);
  });
});

describe('управление', () => {
  it('pause, play, volume', async () => {
    const { audio, engine } = setup();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    engine.pause();
    expect(audio.paused).toBe(true);
    await engine.play();
    expect(audio.paused).toBe(false);
    engine.setVolume(0.4);
    expect(audio.volume).toBe(0.4);
    engine.setVolume(7);
    expect(audio.volume).toBe(1);
    engine.setVolume(-1);
    expect(audio.volume).toBe(0);
  });

  it('play(): AbortError глотается, остальное пробрасывается', async () => {
    const { audio, engine } = setup();
    audio.playError = new DOMException('x', 'AbortError');
    await expect(engine.play()).resolves.toBeUndefined();
    audio.playError = new DOMException('x', 'NotAllowedError');
    await expect(engine.play()).rejects.toThrow('x');
  });

  it('возможности веб-движка и preloadNext без побочных эффектов', () => {
    const { audio, engine } = setup();
    expect(engine.capabilities).toEqual({
      backgroundSafe: false,
      gapless: false,
      headers: false,
      nativeNowPlaying: false,
    });
    engine.load(src(1), { autoplay: true, startAt: 0 });
    engine.preloadNext(src(2));
    engine.preloadNext(null);
    expect(audio.getAttribute('src')).toBe('/s/1');
    expect(audio.playCalls).toBe(1);
  });

  it('on(): отписка работает; dispose снимает слушатели и сбрасывает источник', () => {
    const { audio, engine, events } = setup();
    const extra: AudioEvent[] = [];
    const off = engine.on(e => extra.push(e));
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.fire('playing');
    off();
    audio.fire('loadstart');
    expect(extra).toHaveLength(1);
    expect(events).toHaveLength(2);
    engine.dispose();
    engine.dispose();
    audio.fire('playing');
    expect(events).toHaveLength(2);
    expect(audio.getAttribute('src')).toBeNull();
  });
});

describe('Media Session', () => {
  it('метаданные, обложка и сброс', () => {
    const { engine, session } = setup();
    engine.setNowPlaying(META);
    expect(session.metadata).toMatchObject({
      album: 'Album',
      artist: 'Artist',
      title: 'Song',
    });
    const sizes = (session.metadata as { artwork: { sizes: string }[] }).artwork.map(a => a.sizes);
    expect(sizes).toEqual(['96x96', '128x128', '192x192', '256x256', '384x384', '512x512']);
    // Без обложки — логотип приложения.
    engine.setNowPlaying({ ...META, coverUrl: null });
    expect(session.metadata).toMatchObject({ artwork: [{ sizes: '512x512', src: '/icons/icon-512.png' }] });
    engine.setNowPlaying(null);
    expect(session.metadata).toBeNull();
  });

  it('состояние воспроизведения следует за событиями', () => {
    const { audio, engine, session } = setup();
    expect(session.playbackState).toBe('none');
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.fire('playing');
    expect(session.playbackState).toBe('playing');
    audio.paused = true;
    audio.fire('pause');
    expect(session.playbackState).toBe('paused');
    engine.unload();
    expect(session.playbackState).toBe('none');
  });

  it('действия превращаются в remote-события', () => {
    const { events, session } = setup();
    session.trigger('play');
    session.trigger('pause');
    session.trigger('previoustrack');
    session.trigger('nexttrack');
    session.trigger('seekto', { seekTime: 33 });
    expect(events).toEqual([
      { action: 'play', offset: undefined, seekTo: undefined, type: 'remote' },
      { action: 'pause', offset: undefined, seekTo: undefined, type: 'remote' },
      { action: 'previous', offset: undefined, seekTo: undefined, type: 'remote' },
      { action: 'next', offset: undefined, seekTo: undefined, type: 'remote' },
      { action: 'seekto', offset: undefined, seekTo: 33, type: 'remote' },
    ]);
  });

  it('обработчики seekbackward/seekforward не ставятся: на iOS остаются кнопки трека', () => {
    const { session } = setup();
    expect(session.handlers.get('seekbackward')).toBeNull();
    expect(session.handlers.get('seekforward')).toBeNull();
    expect(session.handlers.get('nexttrack')).toBeTypeOf('function');
  });

  it('неподдерживаемое действие не ломает подключение, dispose снимает обработчики', () => {
    const audio = new FakeAudio();
    const session = new FakeMediaSession();
    session.unsupported.add('seekto');
    const engine = createWebAudioEngine({ audio: audio.asElement(), mediaSession: session.asSession() });
    expect(session.handlers.get('play')).toBeTypeOf('function');
    engine.dispose();
    expect(session.handlers.get('play')).toBeNull();
  });

  it('позиция обновляется не чаще раза в секунду', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { audio, engine, session } = setup();
    engine.setNowPlaying(META);
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.duration = 5;
    audio.fire('loadedmetadata');
    const base = session.positions.length;
    audio.fire('timeupdate');
    audio.fire('timeupdate');
    expect(session.positions.length).toBe(base);
    vi.advanceTimersByTime(1100);
    audio.currentTime = 2;
    audio.fire('timeupdate');
    expect(session.positions.at(-1)).toEqual({ duration: 5, playbackRate: 1, position: 2 });
  });

  it('без поддержки Media Session движок работает (заглушка)', () => {
    vi.stubGlobal('navigator', {});
    const audio = new FakeAudio();
    const engine = createWebAudioEngine({ audio: audio.asElement() });
    engine.setNowPlaying(META);
    engine.load(src(1), { autoplay: false, startAt: 0 });
    audio.fire('loadedmetadata');
    engine.dispose();
  });

  it('позиция вне допустимых значений не падает (длительность 0)', () => {
    const { audio, engine, session } = setup();
    engine.load(src(1), { autoplay: false, startAt: 0 });
    audio.fire('loadedmetadata');
    expect(session.positions).toEqual([]);
  });
});

describe('элемент и фабрика', () => {
  afterEach(() => {
    document.querySelectorAll('[data-testid=player-audio]').forEach(n => n.remove());
  });

  it('createAudioElement: скрытый <audio data-testid="player-audio"> в body', () => {
    const el = createAudioElement();
    expect(el.parentElement).toBe(document.body);
    expect(el.hidden).toBe(true);
    expect(el.getAttribute('data-testid')).toBe('player-audio');
    expect(el.preload).toBe('auto');
  });

  it('createAudioEngine отдаёт один движок на вкладку и один элемент в DOM', () => {
    const a = createAudioEngine();
    const b = createAudioEngine();
    expect(a).toBe(b);
    expect(a).toBe(sharedWebAudioEngine());
    expect(document.querySelectorAll('[data-testid=player-audio]')).toHaveLength(1);
  });
});

describe('мобильные платформы (шаг 50)', () => {
  function setupWith(extra: Partial<Parameters<typeof createWebAudioEngine>[0]> = {}) {
    const audio = new FakeAudio();
    const session = new FakeMediaSession();
    const engine = createWebAudioEngine({ audio: audio.asElement(), mediaSession: session.asSession(), ...extra });
    const events: AudioEvent[] = [];
    engine.on(e => events.push(e));
    return { audio, engine, events, session };
  }

  it('audioSession.type = playback выставляется при создании, до первого play()', () => {
    const audioSession = { type: 'auto' };
    const { audio } = setupWith({ audioSession });
    expect(audioSession.type).toBe('playback');
    expect(audio.playCalls).toBe(0);
  });

  it('пауза не от нас → paused с interrupted; наша пауза — без флага', () => {
    const { audio, engine, events } = setupWith();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.fire('playing');
    audio.pause(); // звонок, наушники
    engine.play().catch(() => undefined);
    audio.fire('playing');
    engine.pause();
    expect(events.filter(e => e.type === 'paused')).toEqual([
      { interrupted: true, type: 'paused' },
      { type: 'paused' },
    ]);
  });

  it('пауза уже стоящего на паузе элемента не оставляет флаг взведённым', () => {
    const { audio, engine, events } = setupWith();
    engine.load(src(1), { autoplay: false, startAt: 0 });
    engine.pause(); // элемент и так на паузе: события pause не будет
    engine.play().catch(() => undefined);
    audio.fire('playing');
    audio.pause();
    expect(events.at(-1)).toEqual({ interrupted: true, type: 'paused' });
  });

  it('Media Session переустанавливается после каждой смены src', () => {
    const { engine, session } = setupWith();
    engine.setNowPlaying(META);
    engine.load(src(1), { autoplay: true, startAt: 0 });
    session.handlers.clear();
    session.metadata = null;
    engine.load(src(2), { autoplay: true, startAt: 0 });
    expect(session.handlers.get('play')).toBeTypeOf('function');
    expect(session.handlers.get('nexttrack')).toBeTypeOf('function');
    expect(session.metadata).toMatchObject({ title: 'Song' });
  });

  it('«застрявший» элемент (нет timeupdate 3 с при playing) перезагружается с позиции один раз', () => {
    vi.useFakeTimers();
    const { audio, engine, events } = setupWith();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.fire('playing');
    audio.currentTime = 42;
    const loads = audio.loadCalls;
    vi.advanceTimersByTime(3000);
    expect(audio.loadCalls).toBe(loads + 1);
    expect(audio.playCalls).toBe(2);
    audio.fire('loadedmetadata');
    expect(audio.currentTime).toBe(42);
    // Второй раз — не пробуем; сообщения об ошибке нет.
    audio.fire('playing');
    vi.advanceTimersByTime(10_000);
    expect(audio.loadCalls).toBe(loads + 1);
    expect(events.some(e => e.type === 'error')).toBe(false);
  });

  it('timeupdate сбрасывает таймер «зависания»', () => {
    vi.useFakeTimers();
    const { audio, engine } = setupWith();
    engine.load(src(1), { autoplay: true, startAt: 0 });
    audio.fire('playing');
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2000);
      audio.fire('timeupdate');
    }
    expect(audio.loadCalls).toBe(0);
  });

  it('play() после ошибки элемента перезагружает источник один раз и не бросает', async () => {
    const { audio, engine } = setupWith();
    engine.load(src(1), { autoplay: false, startAt: 0 });
    audio.currentTime = 17;
    audio.error = { code: 4 };
    await engine.play();
    expect(audio.loadCalls).toBe(1);
    audio.fire('loadedmetadata');
    expect(audio.currentTime).toBe(17);
    // Второй раз ошибка уже ошибка.
    audio.playError = new DOMException('x', 'NotSupportedError');
    await expect(engine.play()).rejects.toThrow();
  });

  it('isPlaying отражает фактическое состояние элемента', () => {
    const { audio, engine } = setupWith();
    expect(engine.isPlaying()).toBe(false);
    engine.load(src(1), { autoplay: true, startAt: 0 });
    expect(engine.isPlaying()).toBe(true);
    audio.paused = true;
    expect(engine.isPlaying()).toBe(false);
  });
});
