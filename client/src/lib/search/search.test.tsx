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
import { shouldRetry, useDebounced, useRemoteSearch } from './use-remote-search';

vi.mock('@/lib/api/search', async importOriginal => ({
  ...(await importOriginal<typeof searchApi>()),
  addToLibraryRequest: vi.fn(),
  searchRemote: vi.fn(),
}));
const search = vi.mocked(searchApi.searchRemote);
const post = vi.mocked(searchApi.addToLibraryRequest);

const t = (key: string, params?: Record<string, string | number>) =>
  translate(en as never, 'en', key, params);

const response = (query: string): SearchResponse => ({ albums: [], artists: [], errors: [], query, tracks: [] });

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFactories();
  search.mockImplementation(async q => response(q));
});
afterEach(() => {
  vi.useRealTimers();
  addingStore.setState({ adding: new Set() });
});

describe('normalizeQuery', () => {
  it('trim, схлопывание пробелов, нижний регистр', () => {
    expect(normalizeQuery('  Radio   HEAD ')).toBe('radio head');
    expect(normalizeQuery('   ')).toBe('');
  });
});

describe('shouldRetry', () => {
  it('4xx не повторяется, сеть и 5xx — один раз', () => {
    expect(shouldRetry(0, new ApiError(400, 'bad_query', 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(401, 'unauthorized', 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(502, 'mb', 'x'))).toBe(true);
    expect(shouldRetry(0, new ApiError(0, 'network', 'x'))).toBe(true);
    expect(shouldRetry(1, new ApiError(502, 'mb', 'x'))).toBe(false);
    expect(shouldRetry(0, new Error('boom'))).toBe(true);
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

  it('устаревший запрос отменяется (signal), прошлый результат помечен «устаревшим»', async () => {
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
    expect(result.current.stale).toBe(false);
    // Второй запрос не отвечает: пока он идёт, видны результаты первого — приглушённые.
    search.mockImplementationOnce(() => new Promise(() => undefined));
    rerender({ q: 'radiohead' });
    expect(result.current.stale).toBe(true);
    await run(SEARCH_DEBOUNCE_MS);
    expect(result.current.stale).toBe(true);
    expect(result.current.data?.query).toBe('radio');
    expect(first).toBeInstanceOf(AbortSignal);
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

  it('5xx повторяется один раз; чужая ошибка оборачивается в ApiError', async () => {
    vi.useFakeTimers();
    search.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useRemoteSearch('radio'), { wrapper: wrapper() });
    await run(SEARCH_DEBOUNCE_MS + 2000);
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.status).toBe(0);
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
    const ok = await addToLibrary(input, t, 'kid a', { post: async () => ({ id: 5, status: 'added', type: 'album' }), requestSync: sync });
    expect(ok).toBe(true);
    expect(sync).toHaveBeenCalledWith('add');
    expect(addingStore.getState().adding.has('mb-1')).toBe(true);
    expect(readHistory()).toEqual(['kid a']);
    expect(toast.success).toHaveBeenCalledWith('Added to the library');
    // Дельта не пришла — через таймаут кнопка возвращается.
    vi.advanceTimersByTime(ADDING_TIMEOUT_MS);
    expect(addingStore.getState().adding.has('mb-1')).toBe(false);
  });

  it('тексты по статусу: exists и importing', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue(1);
    await addToLibrary(input, t, undefined, { post: async () => ({ id: 1, status: 'exists', type: 'album' }), requestSync: sync });
    addingStore.setState({ adding: new Set() });
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
      albums: [makeAlbum({ artist_id: 1, id: 1, mbid: 'rg-1' }), makeAlbum({ artist_id: 1, id: 2, in_library: false, mbid: 'rg-2' })],
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
