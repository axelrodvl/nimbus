// Модульные тесты чистой логики плеера (без браузера).
import { expect, test } from '@playwright/test';
import { en } from '../lib/i18n/messages/en';
import { translate } from '../lib/i18n/translate';
import {
  advanceListen,
  applyShuffle,
  describeBackendError,
  describeDownload,
  playerErrorText,
  initialState,
  nextPlayableIndex,
  parseStored,
  playCountThreshold,
  playerReducer,
  prevPlayableIndex,
  probeStreamError,
  serializeState,
  shuffleAround,
  type Listen,
  type PlayerState,
} from '../providers/player/engine';

const t = ((key: string, params?: Record<string, string | number>) => translate(en, 'en', key, params)) as never;

const track = (id: number, status: 'found' | 'adding' | 'ready' | 'not_found' = 'found') => ({
  album: 'A',
  artist: 'X',
  coverUrl: null,
  durationMs: 10_000,
  id,
  status,
  title: `T${id}`,
});
const queue = [1, 2, 3, 4, 5].map(i => track(i));
const playable = (t: { status: string }) => t.status === 'found' || t.status === 'ready';

test('next/prev пропускают неиграбельные треки и учитывают wrap', () => {
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

test('shuffle: текущий первым, состав тот же, выключение возвращает порядок', () => {
  let n = 0;
  const rng = () => (n += 0.37) % 1;
  const shuffled = shuffleAround(queue, 2, rng);
  expect(shuffled[0].id).toBe(3);
  expect(shuffled.map(t => t.id).sort()).toEqual([1, 2, 3, 4, 5]);

  const state = { index: 2, originalQueue: null, queue };
  const on = applyShuffle(state, true, rng);
  expect(on.index).toBe(0);
  expect(on.queue[0].id).toBe(3);
  expect(on.originalQueue?.map(t => t.id)).toEqual([1, 2, 3, 4, 5]);
  const off = applyShuffle({ ...on }, false);
  expect(off.queue.map(t => t.id)).toEqual([1, 2, 3, 4, 5]);
  expect(off.index).toBe(2);
  expect(off.originalQueue).toBeNull();
});

test('редьюсер: загрузка, тики, очередь', () => {
  let s: PlayerState = playerReducer(initialState, { index: 1, originalQueue: null, queue, type: 'LOAD' });
  expect(s).toMatchObject({ duration: 10, index: 1, isPlaying: true, position: 0, status: 'loading' });
  s = playerReducer(s, { buffered: [[0, 4]], duration: 12.5, position: 3, type: 'TICK' });
  expect(s).toMatchObject({ buffered: [[0, 4]], duration: 12.5, position: 3 });
  // NaN/Infinity длительности не затирают известную
  s = playerReducer(s, { duration: Number.NaN, position: 4, type: 'TICK' });
  expect(s.duration).toBe(12.5);

  s = playerReducer(s, { track: track(9), type: 'PLAY_NEXT' });
  expect(s.queue.map(t => t.id)).toEqual([1, 2, 9, 3, 4, 5]);
  s = playerReducer(s, { track: track(10), type: 'ENQUEUE' });
  expect(s.queue.at(-1)?.id).toBe(10);
  // удаление раньше текущего сдвигает индекс; текущий не удаляется
  s = playerReducer(s, { index: 0, type: 'REMOVE' });
  expect(s.index).toBe(0);
  expect(s.queue[0].id).toBe(2);
  expect(playerReducer(s, { index: 0, type: 'REMOVE' })).toBe(s);

  s = playerReducer(s, { type: 'STOP' });
  expect(s).toMatchObject({ isPlaying: false, position: 0, status: 'paused' });
  s = playerReducer(s, { error: { code: 'x' }, status: 'error', type: 'STATUS' });
  expect(s.error?.code).toBe('x');
  s = playerReducer(s, { status: 'playing', type: 'STATUS' });
  expect(s.error).toBeUndefined();
  s = playerReducer(s, { type: 'VOLUME', volume: 250 });
  expect(s.volume).toBe(100);
});

test('сохранение: круговой обход и защита от мусора', () => {
  const s = playerReducer(initialState, { index: 2, originalQueue: null, queue, type: 'LOAD' });
  const raw = serializeState({ ...s, repeat: 'all', volume: 40 }, 12.5);
  const back = parseStored(raw);
  expect(back).toMatchObject({ index: 2, position: 12.5, repeat: 'all', shuffle: false, volume: 40 });
  expect(back?.queue).toHaveLength(5);

  const restored = playerReducer(initialState, { stored: back!, type: 'RESTORE' });
  expect(restored).toMatchObject({ index: 2, isPlaying: false, position: 12.5, status: 'paused', volume: 40 });

  for (const bad of [null, '', 'oops', '{}', '{"v":2}', JSON.stringify({ queue: [{ id: 'x' }], v: 1 })]) {
    expect(parseStored(bad)).toBeNull();
  }
  // индекс вне очереди и неизвестный repeat приводятся к безопасным значениям
  const odd = parseStored(JSON.stringify({ index: 99, queue, repeat: 'zzz', v: 1, volume: 500 }));
  expect(odd).toMatchObject({ index: 0, repeat: 'off', volume: 100 });
});

test('ошибки бэкенда и форматирование загрузки', async () => {
  expect(playerErrorText(t, describeBackendError('ffmpeg_missing').code)).toContain('ffmpeg');
  expect(playerErrorText(t, describeBackendError('wat').code)).toBe('Could not play the track');

  const fakeFetch = (status: number) => (async () => ({ ok: status < 400, status }) as Response) as typeof fetch;
  expect((await probeStreamError('u', fakeFetch(503))).code).toBe('ffmpeg_missing');
  expect((await probeStreamError('u', fakeFetch(409))).code).toBe('track_not_playable');
  // HEAD проходит — значит, не удалось прочитать данные раздачи
  expect((await probeStreamError('u', fakeFetch(200))).code).toBe('no_peers');
  expect((await probeStreamError('u', (async () => Promise.reject(new Error('x'))) as typeof fetch)).code).toBe(
    'network',
  );

  expect(describeDownload({ bytes_done: 34, bytes_total: 100, down_speed_bps: 1.2 * 1024 * 1024, peers: 12 }, t)).toBe(
    'Downloading from the torrent: 34% · 12 peers · 1.2 MB/s',
  );
  expect(describeDownload({ bytes_done: 0, bytes_total: 0, down_speed_bps: 500, peers: 1 }, t)).toBe(
    'Downloading from the torrent: 0% · 1 peer · 500 B/s',
  );
  expect(describeDownload({ bytes_done: 1, bytes_total: 2, down_speed_bps: 2048, peers: 3 }, t)).toContain(
    '3 peers · 2 KB/s',
  );
});

test('порог прослушивания: половина трека, но не больше 4 минут', () => {
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

test('прослушивание засчитывается один раз — после половины трека', () => {
  const first = listenRange(null, 1, 0, 90, 200);
  expect(first.counts).toBe(0);
  const second = listenRange(first.listen, 1, 90, 200, 200);
  expect(second.counts).toBe(1);
});

test('перемотка не копит время прослушивания', () => {
  let r = listenRange(null, 1, 0, 10, 200);
  // Прыжок на 150 с и ещё немного: суммарно реально прослушано ~20 с.
  r = listenRange(r.listen, 1, 150, 160, 200);
  expect(r.counts).toBe(0);
  expect(r.listen.seconds).toBeLessThan(25);
});

test('другой трек начинает учёт заново', () => {
  const a = listenRange(null, 1, 0, 90, 200);
  const b = listenRange(a.listen, 2, 0, 50, 200);
  expect(b.counts).toBe(0);
  expect(b.listen.trackId).toBe(2);
  expect(b.listen.seconds).toBeLessThan(51);
});
