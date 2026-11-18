import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import { searchRemote, type SearchKind, type SearchResponse } from '@/lib/api/search';
import { MIN_QUERY_LENGTH, normalizeQuery, SEARCH_DEBOUNCE_MS, SEARCH_STALE_MS } from './query';

/** Пауза перед повтором: 1 с, 2 с, 4 с… но не дольше `RETRY_MAX_MS`. */
export const RETRY_MIN_MS = 1000;
export const RETRY_MAX_MS = 8000;

export const retryDelay = (attempt: number): number => Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt);

/**
 * 4xx (плохой запрос, 401) повтор не лечит. Сеть, 5xx и таймауты MusicBrainz повторяются, пока поиск нужен:
 * пользователь ждёт результат, а не ошибку.
 */
export function shouldRetry(_failureCount: number, error: unknown): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
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

const SECTION: Record<string, SearchKind> = { albums: 'album', artists: 'artist', tracks: 'track' };
const FIELD = { album: 'albums', artist: 'artists', track: 'tracks' } as const;

/** Секции, которые сервер не смог отдать (`errors`: «artists: timeout»), — их и повторяем. */
export function failedKinds(data: SearchResponse): SearchKind[] {
  const kinds = new Set<SearchKind>();
  for (const e of data.errors) {
    const kind = SECTION[e.split(':', 1)[0]?.trim() ?? ''];
    if (kind) kinds.add(kind);
  }
  return [...kinds].sort();
}

/** Ответ повтора по `kinds` заменяет только эти секции; ошибки — те, что остались. */
export function mergeSearch(prev: SearchResponse, part: SearchResponse, kinds: readonly SearchKind[]): SearchResponse {
  const failedNow = new Set(failedKinds(part));
  const next: SearchResponse = { ...prev, errors: part.errors };
  for (const kind of kinds) {
    const field = FIELD[kind];
    // Секция снова не ответила — прежнее (обычно пустое) остаётся.
    if (!failedNow.has(kind) || part[field].length > 0) next[field] = part[field] as never;
  }
  return next;
}

export type RemoteSearch = {
  /** Результат именно текущего запроса: прошлый на экране не остаётся. */
  data: SearchResponse | undefined;
  /** Результата ещё нет: идёт запрос (или ждёт debounce, или повтор после сбоя). */
  loading: boolean;
  /** MusicBrainz не ответил (целиком или частью) — поиск повторяет запрос сам. */
  retrying: boolean;
  /** Окончательная ошибка (4xx): повтор не поможет. */
  error: ApiError | null;
  /** Запрос достаточно длинный, чтобы уйти в сеть. */
  active: boolean;
  retry: () => void;
};

/**
 * Поиск в MusicBrainz: debounce 250 мс, отмена устаревшего запроса, кэш по нормализованному запросу на 5 минут.
 * Сбои сети и таймауты повторяются сами (с нарастающей паузой), пока экран открыт; секции, не успевшие ответить,
 * дозапрашиваются отдельно. `enabled = false` (офлайн) — сеть не трогается.
 */
export function useRemoteSearch(query: string, enabled = true): RemoteSearch {
  const typed = normalizeQuery(query);
  const settled = useDebounced(typed, SEARCH_DEBOUNCE_MS);
  const active = enabled && settled.length >= MIN_QUERY_LENGTH;
  const queryClient = useQueryClient();
  const q = useQuery({
    enabled: active,
    gcTime: SEARCH_STALE_MS * 2,
    queryFn: ({ signal }) => searchRemote(settled, signal),
    queryKey: ['search', settled],
    retry: shouldRetry,
    retryDelay,
    staleTime: SEARCH_STALE_MS,
  });
  const wanted = enabled && typed.length >= MIN_QUERY_LENGTH;
  // Ввод изменился — результаты прежнего запроса сразу убираются, даже пока ждём debounce.
  const current = wanted && settled === typed;
  const data = current ? q.data : undefined;

  // Дозапрос секций, которые не ответили (таймаут MusicBrainz): до успеха, с нарастающей паузой.
  const missing = current && q.data ? failedKinds(q.data) : [];
  const missingKey = missing.join(',');
  const [attempt, setAttempt] = useState({ key: '', n: 0 });
  const n = attempt.key === `${settled}|${missingKey}` ? attempt.n : 0;
  useEffect(() => {
    if (!missingKey) return;
    const kinds = missingKey.split(',') as SearchKind[];
    const key = `${settled}|${missingKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchRemote(settled, controller.signal, undefined, kinds)
        .then(part => {
          queryClient.setQueryData<SearchResponse>(['search', settled], prev =>
            prev ? mergeSearch(prev, part, kinds) : prev,
          );
        })
        .catch(() => undefined) // Сеть или 5xx: следующая попытка по таймеру.
        .finally(() => {
          if (!controller.signal.aborted) setAttempt({ key, n: n + 1 });
        });
    }, retryDelay(n));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [missingKey, n, queryClient, settled]);

  const error =
    !current || !q.error ? null : q.error instanceof ApiError ? q.error : new ApiError(0, 'network', String(q.error));
  return {
    active: wanted,
    data,
    error,
    loading: wanted && data === undefined && error === null,
    retry: () => void q.refetch(),
    retrying: current && (missing.length > 0 || (q.isFetching && q.failureCount > 0)),
  };
}
