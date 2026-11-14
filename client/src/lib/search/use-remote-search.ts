import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import { searchRemote, type SearchResponse } from '@/lib/api/search';
import { MIN_QUERY_LENGTH, normalizeQuery, SEARCH_DEBOUNCE_MS, SEARCH_STALE_MS } from './query';

/** Повторяем только сбои сети и 5xx, и только один раз; 4xx (плохой запрос, 401) повтор не лечит. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/** Значение, которое «догоняет» входное через `delay` мс тишины. */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(debounced, value)) return;
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay, debounced]);
  return debounced;
}

export type RemoteSearch = {
  data: SearchResponse | undefined;
  /** Данные от прошлого запроса (идёт новый или ввод ещё не «устоялся») — интерфейс их приглушает. */
  stale: boolean;
  /** Запрос идёт (или ждёт debounce) и показать больше нечего. */
  loading: boolean;
  error: ApiError | null;
  /** Запрос достаточно длинный, чтобы уйти в сеть. */
  active: boolean;
  retry: () => void;
};

/**
 * Поиск в MusicBrainz: debounce 250 мс, отмена устаревшего запроса, кэш по нормализованному запросу на 5 минут,
 * показ прошлого результата, пока идёт новый. `enabled = false` (офлайн) — сеть не трогается.
 */
export function useRemoteSearch(query: string, enabled = true): RemoteSearch {
  const typed = normalizeQuery(query);
  const settled = useDebounced(typed, SEARCH_DEBOUNCE_MS);
  const active = enabled && settled.length >= MIN_QUERY_LENGTH;
  const q = useQuery({
    enabled: active,
    gcTime: SEARCH_STALE_MS * 2,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => searchRemote(settled, signal),
    queryKey: ['search', settled],
    retry: shouldRetry,
    retryDelay: 400,
    staleTime: SEARCH_STALE_MS,
  });
  const wanted = enabled && typed.length >= MIN_QUERY_LENGTH;
  // Ввод короче минимума — результаты прошлого запроса не показываем.
  const data = wanted ? q.data : undefined;
  const pending = wanted && (settled !== typed || q.isFetching);
  return {
    active: wanted,
    data,
    error:
      !wanted || !q.error ? null : q.error instanceof ApiError ? q.error : new ApiError(0, 'network', String(q.error)),
    loading: pending && data === undefined,
    retry: () => void q.refetch(),
    stale: data !== undefined && (q.isPlaceholderData || settled !== typed),
  };
}
