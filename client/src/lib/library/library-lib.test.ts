import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { vi } from 'vitest';
import { enMessages, type TFn } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { formatAudioInfo } from './audio-info';
import { coverSrc } from './cover';
import { albumMeta, describeStatus, isPlayable, statusSummary } from './status';
import { libraryHref, parseStatusFilter, parseTab } from './tabs';
import { createThrottledSource } from '@/lib/store/throttled';
import { filterByName } from '@/lib/store/selectors';

const tEn: TFn = key => String(enMessages[key]);
const t = (key: string, params?: Record<string, string | number>) => translate(enMessages as never, 'en', key, params);

describe('coverSrc', () => {
  const mbid = '11111111-2222-3333-4444-555555555555';
  const base = `https://coverartarchive.org/release-group/${mbid}/front`;
  it('адрес Cover Art Archive превращается в адрес обложки на нашем бэкенде с нужным размером', () => {
    expect(coverSrc(`${base}-250`, 500)).toBe(`/api/covers/release-group/${mbid}/500`);
    expect(coverSrc(`${base}-1200`, 250)).toBe(`/api/covers/release-group/${mbid}/250`);
    expect(coverSrc(base, 250)).toBe(`/api/covers/release-group/${mbid}/250`);
    expect(coverSrc(`https://coverartarchive.org/release/${mbid}/front`, 250)).toBe(`/api/covers/release/${mbid}/250`);
  });
  it('чужие адреса и пустые значения — как есть', () => {
    expect(coverSrc('https://example.com/x.jpg', 250)).toBe('https://example.com/x.jpg');
    expect(coverSrc('https://coverartarchive.org/release-group/abc/front', 250)).toBe(
      'https://coverartarchive.org/release-group/abc/front',
    );
    expect(coverSrc(null, 250)).toBeNull();
    expect(coverSrc(undefined, 250)).toBeNull();
    expect(coverSrc('', 250)).toBeNull();
  });
});

describe('статусы', () => {
  const counts = { adding: 1, found: 0, not_found: 2, ready: 3 };
  it('сводка перечисляет только ненулевые', () => {
    expect(statusSummary(counts, t as never)).toBe('3 downloaded, 1 searching, 2 not found');
  });
  it('подписи статусов и причин', () => {
    const T = t as never;
    expect(describeStatus(T, 'adding', null)).toBe(t('status.label.adding'));
    expect(describeStatus(T, 'adding', null, { done: 1, stage: 'verifying', total: 4 })).toBe(
      t('status.label.verifying', { done: 1, total: 4 }),
    );
    expect(describeStatus(T, 'adding', null, { done: 0, stage: 'searching', total: 0 })).toBe(t('status.label.adding'));
    expect(describeStatus(T, 'found', null)).toBe(t('status.label.found'));
    expect(describeStatus(T, 'ready', null)).toBe(t('status.label.ready'));
    expect(describeStatus(T, 'not_found', 'dead_torrents')).toBe(t('status.reason.dead_torrents'));
    expect(describeStatus(T, 'not_found', 'no_match')).toBe(t('status.reason.no_match'));
    expect(describeStatus(T, 'not_found', 'no_torrents')).toBe(t('status.reason.no_torrents'));
    expect(describeStatus(T, 'not_found', 'other')).toBe(t('status.label.notFound'));
  });
  it('isPlayable и albumMeta', () => {
    expect(['adding', 'found', 'not_found', 'ready'].map(s => isPlayable(s as 'found'))).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect(albumMeta({ artistName: 'A', primary_type: 'EP', year: 2001 }, tEn)).toBe('A · 2001 · EP');
    expect(albumMeta({ artistName: 'A', primary_type: null, year: null }, tEn)).toBe('A');
  });
});

describe('вкладки', () => {
  it('разбор вкладки и фильтра с запасными значениями', () => {
    expect(parseTab('tracks')).toBe('tracks');
    expect(parseTab('x')).toBe('albums');
    expect(parseTab(undefined)).toBe('albums');
    expect(parseStatusFilter('adding')).toBe('adding');
    expect(parseStatusFilter('x')).toBe('all');
    expect(parseStatusFilter(null)).toBe('all');
  });
  it('адрес вкладки хранит фильтры', () => {
    expect(libraryHref('albums', {})).toBe('/library/albums');
    expect(libraryHref('tracks', { q: 'a b', status: 'playable' })).toBe('/library/tracks?status=playable&q=a+b');
    expect(libraryHref('tracks', { status: 'all' })).toBe('/library/tracks');
  });
});

describe('formatAudioInfo', () => {
  it('собирает параметры потока', () => {
    expect(
      formatAudioInfo({
        bit_depth: 24,
        bitrate_kbps: 900,
        channels: 'stereo',
        codec: 'flac',
        ext: 'flac',
        sample_rate: 96000,
        transcoded: false,
      } as never),
    ).toBe('FLAC · 24-bit · 96 kHz · stereo · 900 kbps');
    expect(formatAudioInfo({ codec: null, ext: 'wav', transcoded: true } as never)).toBe('WAV → FLAC');
    expect(formatAudioInfo({ codec: 'pcm_s16le', ext: 'wav', sample_rate: 44100, transcoded: false } as never)).toBe(
      'PCM · 44.1 kHz',
    );
  });
});

describe('filterByName', () => {
  const items = [{ n: 'Élan' }, { n: 'Ёлка' }, { n: 'Other' }];
  it('игнорирует регистр, диакритику и ё/е; пустой запрос — тот же массив', () => {
    expect(filterByName(items, 'elan', i => i.n)).toEqual([items[0]]);
    expect(filterByName(items, 'ЕЛК', i => i.n)).toEqual([items[1]]);
    expect(filterByName(items, '  ', i => i.n)).toBe(items);
    // Повторный вызов берёт нормализованное название из кэша.
    expect(filterByName(items, 'oth', i => i.n)).toEqual([items[2]]);
  });
});

describe('createThrottledSource', () => {
  const make = () => {
    const store = createStore(() => ({ n: 0 }));
    const select = vi.fn((s: { n: number }) => s.n);
    const source = createThrottledSource(store, select, 100);
    const listener = vi.fn();
    return { listener, select, source, store };
  };

  it('серия изменений даёт один пересчёт в конце окна', () => {
    vi.useFakeTimers();
    const { listener, select, source, store } = make();
    expect(source.getSnapshot()).toBe(0);
    const off = source.subscribe(listener);
    for (let i = 1; i <= 50; i++) store.setState({ n: i });
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot()).toBe(50);
    expect(select).toHaveBeenCalledTimes(2); // начальный и один итоговый, а не 50
    off();
    vi.useRealTimers();
  });

  it('изменение после паузы применяется сразу', () => {
    vi.useFakeTimers();
    const { listener, source, store } = make();
    source.getSnapshot();
    const off = source.subscribe(listener);
    vi.advanceTimersByTime(500);
    store.setState({ n: 7 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot()).toBe(7);
    off();
    vi.useRealTimers();
  });

  it('равное значение слушателей не будит; отписка гасит таймер и подписку на store', () => {
    vi.useFakeTimers();
    const store = createStore(() => ({ a: 1, b: 1 }));
    const source = createThrottledSource(store, s => s.a, 100);
    const listener = vi.fn();
    source.getSnapshot();
    const off = source.subscribe(listener);
    vi.advanceTimersByTime(200);
    store.setState({ b: 2 });
    expect(listener).not.toHaveBeenCalled();
    store.setState({ a: 2 });
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);
    store.setState({ a: 3 });
    off();
    vi.advanceTimersByTime(500);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('несколько подписчиков делят один источник; store отпускается после последнего', () => {
    const store = createStore(() => ({ n: 0 }));
    const sub = vi.spyOn(store, 'subscribe');
    const source = createThrottledSource(store, s => s.n, 0);
    const offA = source.subscribe(() => undefined);
    const offB = source.subscribe(() => undefined);
    expect(sub).toHaveBeenCalledTimes(1);
    offA();
    store.setState({ n: 1 });
    expect(source.getSnapshot()).toBe(1);
    offB();
  });
});
