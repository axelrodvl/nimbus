import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import * as searchApi from '@/lib/api/search';
import type { SearchResponse } from '@/lib/api/search-types';
import { appData } from '@/lib/app-data';
import { en } from '@/lib/i18n/messages/en';
import { translate } from '@/lib/i18n/translate';
import { createSelectors } from '@/lib/store/selectors';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { seed } from '@/test/seed';
import { ADDING_TIMEOUT_MS, addErrorMessage, addingStore, addToLibrary } from './add';
import { addToHistory, clearHistory, HISTORY_KEY, HISTORY_LIMIT, readHistory, useSearchHistory } from './history';
import { normalizeQuery, SEARCH_DEBOUNCE_MS } from './query';
import {
  failedKinds,
  isRefinement,
  mergeSearch,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  retryDelay,
  STALE_KEEP_MS,
  shouldRetry,
  useDebounced,
  useRemoteSearch,
} from './use-remote-search';

vi.mock('@/lib/api/search', async importOriginal => ({
  ...(await importOriginal<typeof searchApi>()),
  addToLibraryRequest: vi.fn(),
  searchRemote: vi.fn(),
}));
const search = vi.mocked(searchApi.searchRemote);
const post = vi.mocked(searchApi.addToLibraryRequest);

const t = (key: string, params?: Record<string, string | number>) => translate(en as never, 'en', key, params);

const response = (query: string): SearchResponse => ({ albums: [], artists: [], errors: [], query, tracks: [] });
const artist = { country: null, disambiguation: null, library_id: null, mbid: 'ar', name: 'Radio', score: 100 };
const album = {
  artist_mbid: 'ar',
  artist_name: 'Radio',
  cover_url: null,
  library_id: null,
  mbid: 'rg',
  primary_type: 'Album',
  score: 100,
  secondary_types: [],
  title: 'Radio',
  year: 2000,
} as unknown as SearchResponse['albums'][number];

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFactories();
  search.mockImplementation(async q => response(q));
});
afterEach(() => {
  vi.useRealTimers();
  addingStore.setState({ adding: new Map() });
});

describe('normalizeQuery', () => {
  it('trim, схлопывание пробелов, нижний регистр', () => {
    expect(normalizeQuery('  Radio   HEAD ')).toBe('radio head');
    expect(normalizeQuery('   ')).toBe('');
  });
});

describe('shouldRetry', () => {
  it('4xx не повторяется; сеть и 5xx — сколько угодно раз', () => {
    expect(shouldRetry(0, new ApiError(400, 'bad_query', 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(401, 'unauthorized', 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(502, 'mb', 'x'))).toBe(true);
    expect(shouldRetry(0, new ApiError(0, 'network', 'x'))).toBe(true);
    expect(shouldRetry(50, new ApiError(502, 'mb', 'x'))).toBe(true);
    expect(shouldRetry(0, new Error('boom'))).toBe(true);
  });

  it('пауза перед повтором растёт и ограничена сверху', () => {
    expect([0, 1, 2, 3, 10].map(retryDelay)).toEqual([RETRY_MIN_MS, 2000, 4000, RETRY_MAX_MS, RETRY_MAX_MS]);
  });
});

describe('частичные ответы', () => {
  it('failedKinds: секции из `errors`, без дублей; посторонние строки игнорируются', () => {
    expect(
      failedKinds({
        ...response('q'),
        errors: ['tracks: timeout', 'artists: timeout', 'artists: library lookup failed', 'weird'],
      }),
    ).toEqual(['artist', 'track']);
    expect(failedKinds(response('q'))).toEqual([]);
  });

  it('mergeSearch: повтор заменяет только свои секции; снова упавшая секция сохраняет прежнее', () => {
    const prev: SearchResponse = { ...response('q'), albums: [album], errors: ['artists: timeout', 'tracks: timeout'] };
    const part: SearchResponse = { ...response('q'), artists: [artist], errors: ['tracks: timeout'] };
    const merged = mergeSearch(prev, part, ['artist', 'track']);
    expect(merged.artists).toEqual([artist]);
    expect(merged.albums).toEqual([album]);
    expect(merged.errors).toEqual(['tracks: timeout']);
  });
});

describe('useDebounced', () => {
  it('значение догоняет входное после паузы; новый ввод сбрасывает таймер', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 100), { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    act(() => void vi.advanceTimersByTime(60));
    rerender({ v: 'abc' });
    act(() => void vi.advanceTimersByTime(60));
    expect(result.current).toBe('a');
    act(() => void vi.advanceTimersByTime(60));
    expect(result.current).toBe('abc');
  });
});

describe('useRemoteSearch', () => {
  // Время идёт на `ms`; React дорисовывает состояние при выходе из `act`, поэтому ответ мока и уведомления
  // React Query добираются отдельным коротким шагом.
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const run = async (ms: number) => {
    await tick(ms);
    await tick(50);
  };

  it('быстрый ввод → один запрос после debounce', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ q }) => useRemoteSearch(q), {
      initialProps: { q: '' },
      wrapper: wrapper(),
    });
    rerender({ q: 'ra' });
    rerender({ q: 'rad' });
    rerender({ q: 'radio' });
    await tick(SEARCH_DEBOUNCE_MS - 10);
    expect(search).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
    await run(20);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toBe('radio');
    expect(result.current.data?.query).toBe('radio');
    expect(result.current.loading).toBe(false);
  });

  it('короткий запрос не уходит в сеть и не показывает прошлый результат', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ q }) => useRemoteSearch(q), {
      initialProps: { q: 'radio' },
      wrapper: wrapper(),
    });
    await run(SEARCH_DEBOUNCE_MS);
    expect(result.current.data).toBeDefined();
    rerender({ q: 'r' });
    await run(SEARCH_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBeUndefined();
    expect(result.current.active).toBe(false);
  });

  it('отключённый поиск (офлайн) сети не трогает', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRemoteSearch('radiohead', false), { wrapper: wrapper() });
    await run(SEARCH_DEBOUNCE_MS);
    expect(search).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it('уточнение запроса: прежние данные остаются (stale) до ответа, затем заменяются; несвязанный ввод — загрузка', async () => {
    vi.useFakeTimers();
    search.mockImplementationOnce(async q => response(q));
    const { result, rerender } = renderHook(({ q }) => useRemoteSearch(q), {
      initialProps: { q: 'radiohead' },
      wrapper: wrapper(),
    });
    await run(SEARCH_DEBOUNCE_MS);
    expect(result.current.data?.query).toBe('radiohead');
    expect(result.current.stale).toBe(false);
    let answer: (r: SearchResponse) => void = () => undefined;
    search.mockImplementationOnce(() => new Promise<SearchResponse>(resolve => (answer = resolve)));
    rerender({ q: 'radiohead o' });
    expect(result.current.data?.query).toBe('radiohead');
    expect(result.current.stale).toBe(true);
    expect(result.current.loading).toBe(false);
    await run(SEARCH_DEBOUNCE_MS);
    expect(result.current.data?.query).toBe('radiohead');
    expect(result.current.stale).toBe(true);
    await act(async () => answer(response('radiohead o')));
    await run(10);
    expect(result.current.data?.query).toBe('radiohead o');
    expect(result.current.stale).toBe(false);
    search.mockImplementationOnce(() => new Promise(() => undefined));
    rerender({ q: 'abba' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await run(SEARCH_DEBOUNCE_MS); // запрос ушёл — мок не остаётся «на потом»
  });

  it('прежние данные не держатся дольше STALE_KEEP_MS без ответа', async () => {
    vi.useFakeTimers();
    search.mockImplementationOnce(async q => response(q));
    const { result, rerender } = renderHook(({ q }) => useRemoteSearch(q), {
      initialProps: { q: 'radiohead' },
      wrapper: wrapper(),
    });
    await run(SEARCH_DEBOUNCE_MS);
    search.mockImplementationOnce(() => new Promise(() => undefined));
    rerender({ q: 'radiohead o' });
    expect(result.current.stale).toBe(true);
    await run(STALE_KEEP_MS + 10);
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
  });

  it('isRefinement: продолжение, укорочение и правка в пару символов — да; другое слово — нет', () => {
    expect(isRefinement('radiohead', 'radiohead ok computer')).toBe(true);
    expect(isRefinement('radiohead ok', 'radio')).toBe(true);
    expect(isRefinement('radiohead', 'radiohed')).toBe(true);
    expect(isRefinement('radiohead', 'abba')).toBe(false);
  });

  it('новый ввод несвязанного запроса сразу убирает прежний результат: пока идёт новый запрос — только загрузка', async () => {
    vi.useFakeTimers();
    let first: AbortSignal | undefined;
    search.mockImplementationOnce(async (q, signal) => {
      first = signal;
      return response(q);
    });
    const { result, rerender } = renderHook(({ q }) => useRemoteSearch(q), {
      initialProps: { q: 'radio' },
      wrapper: wrapper(),
    });
    await run(SEARCH_DEBOUNCE_MS);
    expect(result.current.data?.query).toBe('radio');
    search.mockImplementationOnce(() => new Promise(() => undefined));
    rerender({ q: 'abba' });
    // Ещё до debounce.
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await run(SEARCH_DEBOUNCE_MS);
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    expect(first).toBeInstanceOf(AbortSignal);
  });

  it('секции, не успевшие ответить, дозапрашиваются сами до успеха; результат дополняется', async () => {
    vi.useFakeTimers();
    search
      .mockResolvedValueOnce({ ...response('radio'), albums: [album], errors: ['artists: timeout'] })
      .mockResolvedValueOnce({ ...response('radio'), errors: ['artists: timeout'] })
      .mockResolvedValueOnce({ ...response('radio'), artists: [artist] });
    const { result } = renderHook(() => useRemoteSearch('radio'), { wrapper: wrapper() });
    await run(SEARCH_DEBOUNCE_MS);
    expect(result.current.retrying).toBe(true);
    expect(result.current.data?.albums).toEqual([album]);
    await run(RETRY_MIN_MS);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]?.[3]).toEqual(['artist']);
    expect(result.current.retrying).toBe(true);
    // Вторая пауза длиннее.
    await run(RETRY_MIN_MS);
    expect(search).toHaveBeenCalledTimes(2);
    await run(RETRY_MIN_MS);
    expect(search).toHaveBeenCalledTimes(3);
    expect(result.current.retrying).toBe(false);
    expect(result.current.data?.artists).toEqual([artist]);
    expect(result.current.data?.albums).toEqual([album]);
    expect(result.current.data?.errors).toEqual([]);
  });

  it('сбой сети при дозапросе — следующая попытка; уход с запроса отменяет повторы', async () => {
    vi.useFakeTimers();
    search
      .mockResolvedValueOnce({ ...response('radio'), errors: ['tracks: timeout'] })
      .mockRejectedValueOnce(new ApiError(0, 'network', 'x'));
    const { result, rerender } = renderHook(({ q }) => useRemoteSearch(q), {
      initialProps: { q: 'radio' },
      wrapper: wrapper(),
    });
    await run(SEARCH_DEBOUNCE_MS);
    await run(RETRY_MIN_MS);
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.current.retrying).toBe(true);
    rerender({ q: 'r' });
    await run(RETRY_MAX_MS * 2);
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.current.retrying).toBe(false);
  });

  it('ушли с экрана до ответа — запрос не отменяется, «назад» сразу показывает результат без нового запроса', async () => {
    vi.useFakeTimers();
    let resolve: (r: SearchResponse) => void = () => {};
    let signal: AbortSignal | undefined;
    search.mockImplementationOnce((_q, s) => {
      signal = s;
      return new Promise(r => {
        resolve = r;
      });
    });
    const w = wrapper();
    const first = renderHook(() => useRemoteSearch('macklemore'), { wrapper: w });
    await run(SEARCH_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(1);
    // Открыли артиста из «В библиотеке», пока MusicBrainz ещё отвечал.
    first.unmount();
    expect(signal?.aborted).toBe(false);
    await act(async () => resolve(response('macklemore')));
    const back = renderHook(() => useRemoteSearch('macklemore'), { wrapper: w });
    expect(back.result.current.data?.query).toBe('macklemore');
    expect(back.result.current.loading).toBe(false);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('новый ввод отменяет запрос прежнего, ещё не ответившего, — без повторов в фоне', async () => {
    vi.useFakeTimers();
    let first: AbortSignal | undefined;
    search.mockImplementationOnce(
      (_q, s) =>
        new Promise((_, reject) => {
          first = s;
          s?.addEventListener('abort', () => reject(new ApiError(0, 'network', 'aborted')));
        }),
    );
    const { rerender } = renderHook(({ q }) => useRemoteSearch(q), {
      initialProps: { q: 'mack' },
      wrapper: wrapper(),
    });
    await run(SEARCH_DEBOUNCE_MS);
    rerender({ q: 'macklemore' });
    await run(SEARCH_DEBOUNCE_MS);
    expect(first?.aborted).toBe(true);
    await run(RETRY_MAX_MS * 2);
    expect(search.mock.calls.map(c => c[0])).toEqual(['mack', 'macklemore']);
  });

  it('возврат к прежнему запросу — из кэша, без сети (регистр и пробелы не важны)', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ q }) => useRemoteSearch(q), {
      initialProps: { q: 'radio' },
      wrapper: wrapper(),
    });
    await run(SEARCH_DEBOUNCE_MS);
    rerender({ q: 'radiohead' });
    await run(SEARCH_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(2);
    rerender({ q: '  RADIO ' });
    await run(SEARCH_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.current.data?.query).toBe('radio');
  });

  it('4xx не повторяется; повтор вручную работает', async () => {
    vi.useFakeTimers();
    search.mockRejectedValueOnce(new ApiError(400, 'bad_query', 'bad'));
    const { result } = renderHook(() => useRemoteSearch('radio'), { wrapper: wrapper() });
    await run(SEARCH_DEBOUNCE_MS + 1000);
    expect(search).toHaveBeenCalledTimes(1);
    expect(result.current.error?.code).toBe('bad_query');
    act(() => result.current.retry());
    await run(10);
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });

  it('ошибка прежнего запроса не показывается, когда ввод стал короче минимума', async () => {
    vi.useFakeTimers();
    search.mockRejectedValueOnce(new ApiError(400, 'bad_query', 'bad'));
    const { result, rerender } = renderHook(({ q }) => useRemoteSearch(q), {
      initialProps: { q: 'radio' },
      wrapper: wrapper(),
    });
    await run(SEARCH_DEBOUNCE_MS);
    expect(result.current.error).not.toBeNull();
    rerender({ q: 'r' });
    expect(result.current.error).toBeNull();
  });

  it('сбой сети и 5xx: ошибки не показываем, повторяем, пока не ответит', async () => {
    vi.useFakeTimers();
    search
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new ApiError(502, 'mb', 'x'))
      .mockRejectedValueOnce(new ApiError(0, 'network', 'x'));
    const { result } = renderHook(() => useRemoteSearch('radio'), { wrapper: wrapper() });
    await run(SEARCH_DEBOUNCE_MS);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.retrying).toBe(true);
    await run(RETRY_MIN_MS + 2000 + 4000);
    expect(search).toHaveBeenCalledTimes(4);
    expect(result.current.error).toBeNull();
    expect(result.current.retrying).toBe(false);
    expect(result.current.data?.query).toBe('radio');
  });
});

describe('история запросов', () => {
  it('добавление: новые первыми, без дублей (регистр, пробелы), максимум 10', () => {
    addToHistory('  radio   head ');
    addToHistory('björk');
    addToHistory('Radio Head');
    expect(readHistory()).toEqual(['Radio Head', 'björk']);
    addToHistory('   ');
    expect(readHistory()).toHaveLength(2);
    for (let i = 0; i < 15; i++) addToHistory(`q${i}`);
    expect(readHistory()).toHaveLength(HISTORY_LIMIT);
    expect(readHistory()[0]).toBe('q14');
  });

  it('очистка, подписка и чужая запись из другой вкладки', () => {
    const { result } = renderHook(() => useSearchHistory());
    act(() => addToHistory('a1'));
    expect(result.current).toEqual(['a1']);
    expect(localStorage.getItem(HISTORY_KEY)).toContain('a1');
    localStorage.setItem(HISTORY_KEY, JSON.stringify(['other tab']));
    act(() => void globalThis.dispatchEvent(new StorageEvent('storage', { key: HISTORY_KEY })));
    expect(result.current).toEqual(['other tab']);
    act(() => void globalThis.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' })));
    act(() => clearHistory());
    expect(result.current).toEqual([]);
    expect(localStorage.getItem(HISTORY_KEY)).toBeNull();
  });

  it('повреждённое или чужое значение — пустая история; недоступное хранилище не ломает', () => {
    localStorage.setItem(HISTORY_KEY, '{not json');
    expect(readHistory()).toEqual([]);
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ a: 1 }));
    expect(readHistory()).toEqual([]);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(['ok', 5, null]));
    expect(readHistory()).toEqual(['ok']);
    const denied = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: denied, removeItem: denied, setItem: denied });
    expect(readHistory()).toEqual([]);
    expect(() => addToHistory('x')).not.toThrow();
  });
});

describe('addToLibrary', () => {
  const input = { mbid: 'mb-1', type: 'album' } as const;
  const sync = vi.fn();

  it('POST → requestSync("add"); «добавляется» держится до появления сущности, запрос сохраняется в историю', async () => {
    vi.useFakeTimers();
    vi.spyOn(toast, 'success').mockReturnValue(1);
    const ok = await addToLibrary(input, t, 'kid a', {
      post: async () => ({ id: 5, status: 'added', type: 'album' }),
      requestSync: sync,
    });
    expect(ok).toBe(true);
    expect(sync).toHaveBeenCalledWith('add');
    expect(addingStore.getState().adding.has('mb-1')).toBe(true);
    expect(readHistory()).toEqual(['kid a']);
    expect(toast.success).toHaveBeenCalledWith('Added to the library');
    // Дельта не пришла — через таймаут кнопка возвращается.
    vi.advanceTimersByTime(ADDING_TIMEOUT_MS);
    expect(addingStore.getState().adding.has('mb-1')).toBe(false);
  });

  it('сразу после нажатия — в списке добавляемого с превью и временем; в POST превью не уходит', async () => {
    let finish: (v: searchApi.AddResult) => void = () => undefined;
    const slow = vi.fn((_: searchApi.AddInput) => new Promise<searchApi.AddResult>(r => (finish = r)));
    vi.spyOn(toast, 'success').mockReturnValue(1);
    const done = addToLibrary({ ...input, preview: { cover: 'c.jpg', title: 'Kid A' } }, t, undefined, {
      now: () => 42,
      post: slow,
      requestSync: sync,
    });
    expect(addingStore.getState().adding.get('mb-1')).toEqual({
      at: 42,
      mbid: 'mb-1',
      preview: { cover: 'c.jpg', title: 'Kid A' },
      type: 'album',
    });
    expect(slow).toHaveBeenCalledWith(input);
    finish({ id: 1, status: 'added', type: 'album' });
    await done;
  });

  it('тексты по статусу: exists и importing', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue(1);
    await addToLibrary(input, t, undefined, {
      post: async () => ({ id: 1, status: 'exists', type: 'album' }),
      requestSync: sync,
    });
    addingStore.setState({ adding: new Map() });
    await addToLibrary({ mbid: 'mb-2', type: 'artist' }, t, undefined, {
      post: async () => ({ id: 2, status: 'importing', type: 'artist' }),
      requestSync: sync,
    });
    expect(success.mock.calls.map(c => c[0])).toEqual(['Already in the library', 'Importing the discography…']);
    expect(readHistory()).toEqual([]);
  });

  it('двойной клик не создаёт второй запрос', async () => {
    let finish: (v: searchApi.AddResult) => void = () => undefined;
    const slow = vi.fn(() => new Promise<searchApi.AddResult>(r => (finish = r)));
    vi.spyOn(toast, 'success').mockReturnValue(1);
    const first = addToLibrary(input, t, undefined, { post: slow, requestSync: sync });
    expect(await addToLibrary(input, t, undefined, { post: slow, requestSync: sync })).toBe(false);
    expect(slow).toHaveBeenCalledTimes(1);
    finish({ id: 1, status: 'added', type: 'album' });
    expect(await first).toBe(true);
  });

  it('ошибка: кнопка возвращается, toast с переводом по коду, синхронизация не запрашивается', async () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue(1);
    const ok = await addToLibrary(input, t, 'q', {
      post: async () => {
        throw new ApiError(404, 'mb_not_found', 'raw');
      },
      requestSync: sync,
    });
    expect(ok).toBe(false);
    expect(error).toHaveBeenCalledWith('Not found in MusicBrainz');
    expect(addingStore.getState().adding.has('mb-1')).toBe(false);
    expect(sync).not.toHaveBeenCalled();
    expect(readHistory()).toEqual([]);
  });

  it('без deps: POST и requestSync движка', async () => {
    seed();
    post.mockResolvedValue({ id: 1, status: 'added', type: 'album' });
    const spy = vi.spyOn(appData().engine, 'requestSync').mockImplementation(() => undefined);
    vi.spyOn(toast, 'success').mockReturnValue(1);
    expect(await addToLibrary(input, t)).toBe(true);
    expect(post).toHaveBeenCalledWith(input);
    expect(spy).toHaveBeenCalledWith('add');
  });

  it('addErrorMessage: неизвестный код → сообщение сервера; не ApiError → текст ошибки', () => {
    expect(addErrorMessage(new ApiError(500, 'weird', 'server says'), t)).toBe('server says');
    expect(addErrorMessage(new Error('plain'), t)).toBe('plain');
    expect(addErrorMessage('str', t)).toBe('str');
  });
});

describe('индекс mbid → id', () => {
  it('в индексе только объекты библиотеки; та же ссылка при неизменных данных', () => {
    seed({
      albums: [
        makeAlbum({ artist_id: 1, id: 1, mbid: 'rg-1' }),
        makeAlbum({ artist_id: 1, id: 2, in_library: false, mbid: 'rg-2' }),
      ],
      artists: [makeArtist({ id: 1, mbid: 'ar-1' }), makeArtist({ id: 2, in_library: false, mbid: 'ar-2' })],
      tracks: [
        makeTrack({ album_id: 1, id: 1, mbid_recording: 'rec-1' }),
        makeTrack({ album_id: 1, id: 2, in_library: false, mbid_recording: 'rec-2' }),
      ],
    });
    const s = appData().library.getState();
    const { mbidIndex } = createSelectors();
    const index = mbidIndex(s);
    expect([...index.artists]).toEqual([['ar-1', 1]]);
    expect([...index.albums]).toEqual([['rg-1', 1]]);
    expect([...index.tracks]).toEqual([['rec-1', { albumId: 1, id: 1 }]]);
    expect(mbidIndex(s)).toBe(index);
  });
});
