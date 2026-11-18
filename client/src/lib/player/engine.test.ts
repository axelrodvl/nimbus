// Перенос `web/tests/player-engine.spec.ts` (все случаи) + новое поведение (перестановка очереди).
import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { translate } from '@/lib/i18n/translate';
import type { TFn } from '@/lib/i18n/messages';
import { pt } from '@/test/player';
import {
  advanceListen,
  applyShuffle,
  currentTrack,
  describeBackendError,
  describeDownload,
  formatSpeed,
  initialState,
  nextPlayableIndex,
  parseStored,
  playCountThreshold,
  playerErrorText,
  playerReducer,
  prevPlayableIndex,
  probeStreamError,
  serializeState,
  shuffleAround,
  toRanges,
  type Listen,
  type PlayerState,
} from './engine';

const t: TFn = (key, params) => translate(en, 'en', key, params);
const track = (id: number, status: 'found' | 'adding' | 'ready' | 'not_found' = 'found') =>
  pt(id, { album: 'A', albumId: undefined, artist: 'X', artistId: undefined, status });
const queue = [1, 2, 3, 4, 5].map(i => track(i));
const playable = (x: { status: string }) => x.status === 'found' || x.status === 'ready';

describe('очередь', () => {
  it('next/prev пропускают неиграбельные треки и учитывают wrap', () => {
    const q = [track(1), track(2, 'adding'), track(3), track(4, 'not_found')];
    expect(nextPlayableIndex(q, 0, playable, false)).toBe(2);
    expect(nextPlayableIndex(q, 2, playable, false)).toBe(-1);
    expect(nextPlayableIndex(q, 2, playable, true)).toBe(0);
    expect(prevPlayableIndex(q, 2, playable, false)).toBe(0);
    expect(prevPlayableIndex(q, 0, playable, false)).toBe(-1);
    expect(prevPlayableIndex(q, 0, playable, true)).toBe(2);
    // единственный играбельный трек при wrap возвращается сам
    expect(nextPlayableIndex([track(1)], 0, playable, true)).toBe(0);
  });

  it('shuffle: текущий первым, состав тот же, выключение возвращает порядок', () => {
    let n = 0;
    const rng = () => (n += 0.37) % 1;
    const shuffled = shuffleAround(queue, 2, rng);
    expect(shuffled[0].id).toBe(3);
    expect(shuffled.map(x => x.id).sort()).toEqual([1, 2, 3, 4, 5]);

    const state = { index: 2, originalQueue: null, queue };
    const on = applyShuffle(state, true, rng);
    expect(on.index).toBe(0);
    expect(on.queue[0].id).toBe(3);
    expect(on.originalQueue?.map(x => x.id)).toEqual([1, 2, 3, 4, 5]);
    const off = applyShuffle({ ...on }, false);
    expect(off.queue.map(x => x.id)).toEqual([1, 2, 3, 4, 5]);
    expect(off.index).toBe(2);
    expect(off.originalQueue).toBeNull();
  });

  it('shuffle без текущего трека: очередь не перемешивается; выключение без оригинала сохраняет индекс', () => {
    const empty = applyShuffle({ index: -1, originalQueue: null, queue: [] }, true);
    expect(empty).toEqual({ index: -1, originalQueue: [], queue: [] });
    expect(shuffleAround([], -1)).toEqual([]);
    const off = applyShuffle({ index: 1, originalQueue: null, queue }, false);
    expect(off.index).toBe(1);
  });
});

describe('редьюсер', () => {
  it('загрузка, тики, очередь', () => {
    let s: PlayerState = playerReducer(initialState, { index: 1, originalQueue: null, queue, type: 'LOAD' });
    expect(s).toMatchObject({ duration: 10, index: 1, isPlaying: true, position: 0, status: 'loading' });
    s = playerReducer(s, { duration: 12.5, position: 3, type: 'TICK' });
    expect(s).toMatchObject({ duration: 12.5, position: 3 });
    // NaN/Infinity длительности не затирают известную
    s = playerReducer(s, { duration: Number.NaN, position: 4, type: 'TICK' });
    expect(s.duration).toBe(12.5);

    s = playerReducer(s, { track: track(9), type: 'PLAY_NEXT' });
    expect(s.queue.map(x => x.id)).toEqual([1, 2, 9, 3, 4, 5]);
    s = playerReducer(s, { track: track(10), type: 'ENQUEUE' });
    expect(s.queue.at(-1)?.id).toBe(10);
    // удаление раньше текущего сдвигает индекс; текущий не удаляется
    s = playerReducer(s, { index: 0, type: 'REMOVE' });
    expect(s.index).toBe(0);
    expect(s.queue[0].id).toBe(2);
    expect(playerReducer(s, { index: 0, type: 'REMOVE' })).toBe(s);
    expect(playerReducer(s, { index: 99, type: 'REMOVE' })).toBe(s);

    s = playerReducer(s, { type: 'STOP' });
    expect(s).toMatchObject({ isPlaying: false, position: 0, status: 'paused' });
    s = playerReducer(s, { error: { code: 'x' }, status: 'error', type: 'STATUS' });
    expect(s.error?.code).toBe('x');
    s = playerReducer(s, { status: 'playing', type: 'STATUS' });
    expect(s.error).toBeUndefined();
    s = playerReducer(s, { type: 'VOLUME', volume: 250 });
    expect(s.volume).toBe(100);
    s = playerReducer(s, { type: 'VOLUME', volume: -5 });
    expect(s.volume).toBe(0);
  });

  it('GOTO начинает трек с нуля, PLAYING/CANCEL/MUTED/REPEAT/SHUFFLE меняют своё поле', () => {
    let s = playerReducer(initialState, { index: 0, originalQueue: null, queue, type: 'LOAD', position: 7 });
    expect(s.position).toBe(7);
    s = playerReducer(s, { index: 2, type: 'GOTO' });
    expect(s).toMatchObject({ index: 2, position: 0, status: 'loading' });
    s = playerReducer(s, { type: 'PLAYING', value: false });
    expect(s.isPlaying).toBe(false);
    s = playerReducer(s, { muted: true, type: 'MUTED' });
    expect(s.muted).toBe(true);
    s = playerReducer(s, { repeat: 'one', type: 'REPEAT' });
    expect(s.repeat).toBe('one');
    s = playerReducer(s, { index: 0, originalQueue: queue, queue, shuffle: true, type: 'SHUFFLE' });
    expect(s).toMatchObject({ index: 0, shuffle: true });
    s = playerReducer(s, { type: 'CANCEL' });
    expect(s).toMatchObject({ isPlaying: false, status: 'idle' });
  });

  it('при включённом shuffle добавленные треки попадают и в исходный порядок', () => {
    let s = playerReducer(initialState, { index: 0, originalQueue: queue, queue, type: 'LOAD' });
    s = playerReducer(s, { track: track(9), type: 'ENQUEUE' });
    s = playerReducer(s, { track: track(8), type: 'PLAY_NEXT' });
    expect(s.originalQueue?.map(x => x.id)).toEqual([1, 2, 3, 4, 5, 9, 8]);
    const removed = s.queue[3].id;
    s = playerReducer(s, { index: 3, type: 'REMOVE' });
    expect(s.queue.map(x => x.id)).not.toContain(removed);
    expect(s.originalQueue?.map(x => x.id)).not.toContain(removed);
  });

  it('перестановка очереди: только следующие за текущим', () => {
    const s = playerReducer(initialState, { index: 1, originalQueue: null, queue, type: 'LOAD' });
    const moved = playerReducer(s, { from: 4, to: 2, type: 'MOVE' });
    expect(moved.queue.map(x => x.id)).toEqual([1, 2, 5, 3, 4]);
    expect(moved.index).toBe(1);
    // текущий и сыгранные не двигаются, выход за границы и нулевой сдвиг — без изменений
    for (const [from, to] of [
      [1, 3],
      [0, 3],
      [3, 1],
      [3, 0],
      [3, 3],
      [9, 3],
      [3, 9],
    ]) {
      expect(playerReducer(s, { from, to, type: 'MOVE' })).toBe(s);
    }
  });

  it('currentTrack: null при пустой очереди', () => {
    expect(currentTrack(initialState)).toBeNull();
    expect(currentTrack({ index: 1, queue })?.id).toBe(2);
  });
});

describe('сохранение', () => {
  it('круговой обход и защита от мусора', () => {
    const s = playerReducer(initialState, { index: 2, originalQueue: null, queue, type: 'LOAD' });
    const raw = serializeState({ ...s, repeat: 'all', volume: 40 }, 12.5);
    const back = parseStored(raw);
    expect(back).toMatchObject({ index: 2, position: 12.5, repeat: 'all', shuffle: false, volume: 40 });
    expect(back?.queue).toHaveLength(5);

    const restored = playerReducer(initialState, { stored: back!, type: 'RESTORE' });
    expect(restored).toMatchObject({ index: 2, isPlaying: false, position: 12.5, status: 'paused', volume: 40 });

    for (const bad of [null, '', 'oops', '{}', 'null', '{"v":2}', JSON.stringify({ queue: [{ id: 'x' }], v: 1 })]) {
      expect(parseStored(bad)).toBeNull();
    }
    // индекс вне очереди и неизвестный repeat приводятся к безопасным значениям
    const odd = parseStored(JSON.stringify({ index: 99, queue, repeat: 'zzz', v: 1, volume: 500 }));
    expect(odd).toMatchObject({ index: 0, repeat: 'off', volume: 100 });
  });

  it('shuffle восстанавливается только вместе с исходным порядком; пустая очередь — idle', () => {
    const q = queue.slice(0, 3);
    const withOriginal = parseStored(JSON.stringify({ index: 0, originalQueue: q, queue: q, shuffle: true, v: 1 }));
    expect(withOriginal).toMatchObject({ shuffle: true });
    const without = parseStored(JSON.stringify({ index: 0, queue: q, shuffle: true, v: 1 }));
    expect(without).toMatchObject({ originalQueue: null, shuffle: false });
    const empty = parseStored(JSON.stringify({ queue: [], v: 1 }));
    expect(empty).toMatchObject({ index: -1 });
    expect(playerReducer(initialState, { stored: empty!, type: 'RESTORE' }).status).toBe('idle');
  });

  it('в хранилище попадает не больше 200 треков', () => {
    const big = Array.from({ length: 300 }, (_, i) => track(i + 1));
    const s = playerReducer(initialState, { index: 0, originalQueue: big, queue: big, type: 'LOAD' });
    const back = parseStored(serializeState({ ...s, shuffle: true }, 0));
    expect(back?.queue).toHaveLength(200);
    expect(back?.queue[0].id).toBe(1);
  });

  it('длинная очередь: сохраняется окно вокруг текущего трека, индекс пересчитан', () => {
    const big = Array.from({ length: 500 }, (_, i) => track(i + 1));
    const s = playerReducer(initialState, { index: 349, originalQueue: null, queue: big, type: 'LOAD' });
    const back = parseStored(serializeState(s, 12));
    expect(back?.queue).toHaveLength(200);
    expect(back?.queue[back.index].id).toBe(350); // текущий трек сохранён, а не «первый из окна»
    expect(back?.position).toBe(12);
    // у конца очереди окно упирается в хвост
    const tail = playerReducer(initialState, { index: 495, originalQueue: null, queue: big, type: 'LOAD' });
    const backTail = parseStored(serializeState(tail, 0));
    expect(backTail?.queue.at(-1)?.id).toBe(500);
    expect(backTail?.queue[backTail.index].id).toBe(496);
    // при shuffle окно исходного порядка тоже содержит текущий трек
    const shuffled = playerReducer(initialState, {
      index: 0,
      originalQueue: big,
      queue: [big[349], ...big],
      type: 'LOAD',
    });
    const backShuffled = parseStored(serializeState({ ...shuffled, shuffle: true }, 0));
    expect(backShuffled?.originalQueue?.some(t => t.id === 350)).toBe(true);
  });
});

describe('ошибки и форматирование', () => {
  it('тексты ошибок бэкенда и запасной вариант', () => {
    expect(playerErrorText(t, describeBackendError('ffmpeg_missing').code)).toContain('ffmpeg');
    expect(playerErrorText(t, 'network')).toBe('No connection to the server');
    expect(playerErrorText(t, describeBackendError('wat').code)).toBe('Could not play the track');
    expect(describeBackendError(undefined).code).toBe('unknown');
  });

  it('probeStreamError: HEAD расшифровывает отказ потока', async () => {
    const fakeFetch = (status: number) => (async () => ({ ok: status < 400, status }) as Response) as typeof fetch;
    expect((await probeStreamError('u', fakeFetch(503))).code).toBe('ffmpeg_missing');
    expect((await probeStreamError('u', fakeFetch(409))).code).toBe('track_not_playable');
    expect((await probeStreamError('u', fakeFetch(425))).code).toBe('image_downloading');
    expect((await probeStreamError('u', fakeFetch(504))).code).toBe('no_peers');
    expect((await probeStreamError('u', fakeFetch(500))).code).toBe('unknown');
    // HEAD проходит — значит, не удалось прочитать данные раздачи
    expect((await probeStreamError('u', fakeFetch(200))).code).toBe('no_peers');
    expect((await probeStreamError('u', (async () => Promise.reject(new Error('x'))) as typeof fetch)).code).toBe(
      'network',
    );
  });

  it('probeStreamError передаёт заголовки авторизации и cookie', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const doFetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    await probeStreamError('/s/1', doFetch, { Authorization: 'Bearer x' });
    expect(calls[0]).toEqual([
      '/s/1',
      { credentials: 'include', headers: { Authorization: 'Bearer x' }, method: 'HEAD' },
    ]);
  });

  it('описание загрузки из торрента и скорость', () => {
    expect(
      describeDownload({ bytes_done: 34, bytes_total: 100, down_speed_bps: 1.2 * 1024 * 1024, peers: 12 }, t),
    ).toBe('Downloading from the torrent: 34% · 12 peers · 1.2 MB/s');
    expect(describeDownload({ bytes_done: 0, bytes_total: 0, down_speed_bps: 500, peers: 1 }, t)).toBe(
      'Downloading from the torrent: 0% · 1 peer · 500 B/s',
    );
    expect(describeDownload({ bytes_done: 1, bytes_total: 2, down_speed_bps: 2048, peers: 3 }, t)).toContain(
      '3 peers · 2 KB/s',
    );
    expect(describeDownload({ bytes_done: 500, bytes_total: 100, down_speed_bps: 0, peers: 0 }, t)).toContain('100%');
    expect(formatSpeed(10, t)).toBe('10 B/s');
  });

  it('toRanges превращает TimeRanges в пары', () => {
    const r = { end: (i: number) => [4, 9][i], length: 2, start: (i: number) => [0, 6][i] };
    expect(toRanges(r)).toEqual([
      [0, 4],
      [6, 9],
    ]);
  });
});

describe('счётчик прослушиваний', () => {
  it('порог: половина трека, но не больше 4 минут', () => {
    expect(playCountThreshold(200)).toBe(100);
    expect(playCountThreshold(1000)).toBe(240);
    expect(playCountThreshold(0)).toBe(30);
  });

  // Имитация `timeupdate` каждые 0.25 с на отрезке [from, to).
  function listenRange(prev: Listen | null, id: number, from: number, to: number, duration: number) {
    let listen = prev;
    let counts = 0;
    for (let p = from; p < to; p += 0.25) {
      const r = advanceListen(listen, id, p, duration);
      listen = r.listen;
      if (r.count) counts++;
    }
    return { counts, listen: listen! };
  }

  it('засчитывается один раз — после половины трека', () => {
    const first = listenRange(null, 1, 0, 90, 200);
    expect(first.counts).toBe(0);
    const second = listenRange(first.listen, 1, 90, 200, 200);
    expect(second.counts).toBe(1);
  });

  it('перемотка не копит время прослушивания', () => {
    let r = listenRange(null, 1, 0, 10, 200);
    // Прыжок на 150 с и ещё немного: суммарно реально прослушано ~20 с.
    r = listenRange(r.listen, 1, 150, 160, 200);
    expect(r.counts).toBe(0);
    expect(r.listen.seconds).toBeLessThan(25);
  });

  it('другой трек начинает учёт заново', () => {
    const a = listenRange(null, 1, 0, 90, 200);
    const b = listenRange(a.listen, 2, 0, 50, 200);
    expect(b.counts).toBe(0);
    expect(b.listen.trackId).toBe(2);
    expect(b.listen.seconds).toBeLessThan(51);
  });
});
