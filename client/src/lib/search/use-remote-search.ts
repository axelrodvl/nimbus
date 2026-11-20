import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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

/** Запросы в пути по нормализованной строке: отменяются, только когда ввод сменился. */
const inflight = new Map<string, AbortController>();

/**
 * Запрос со своим `AbortController`, а не `signal` React Query: тот отменяет запрос, как только у него не осталось
 * подписчиков, — уход с экрана (открыли артиста, пока MusicBrainz отвечал) выбрасывал почти готовый ответ, и «назад»
 * начинал поиск заново со skeleton. Свой контроллер отменяется только новым вводом (`cancelSearch`).
 */
function fetchSearch(query: string): Promise<SearchResponse> {
  const controller = new AbortController();
  inflight.set(query, controller);
  return searchRemote(query, controller.signal).finally(() => {
    if (inflight.get(query) === controller) inflight.delete(query);
  });
}

/** Как долго результаты прежнего запроса остаются на экране после правки ввода, пока нового ответа нет. */
export const STALE_KEEP_MS = 1000;

/** Правка в пару символов: Левенштейн ≤ 2. */
function editDistanceWithin2(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return (prev[b.length] ?? 3) <= 2;
}

/** Новый запрос — продолжение (или укорочение, или правка в пару символов) прежнего: прежние результаты ещё годятся. */
export function isRefinement(shown: string, next: string): boolean {
  return shown.startsWith(next) || next.startsWith(shown) || editDistanceWithin2(shown, next);
}

export type RemoteSearch = {
  /**
   * Результат текущего запроса. Пока он не пришёл, а ввод — уточнение прежнего (см. `isRefinement`), остаётся
   * прежний (`stale`) не дольше `STALE_KEEP_MS`; результаты несвязанного запроса не показываются никогда.
   */
  data: SearchResponse | undefined;
  /** `data` — результаты прежнего запроса: новые ещё не пришли. */
  stale: boolean;
  /** Показывать нечего: идёт запрос (или ждёт debounce, или повтор после сбоя). */
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
    queryFn: () => fetchSearch(settled),
    queryKey: ['search', settled],
    retry: shouldRetry,
    retryDelay,
    staleTime: SEARCH_STALE_MS,
  });
  // Ввод сменился — запрос прежнего больше не нужен: сначала React Query (откат состояния, без повторов), затем сеть.
  const previous = useRef(settled);
  useEffect(() => {
    const prev = previous.current;
    previous.current = settled;
    if (prev === settled) return;
    void queryClient.cancelQueries({ exact: true, queryKey: ['search', prev] });
    inflight.get(prev)?.abort();
  }, [settled, queryClient]);
  const wanted = enabled && typed.length >= MIN_QUERY_LENGTH;
  // Ввод изменился — данные текущего запроса есть только после debounce и ответа.
  const current = wanted && settled === typed;
  const fresh = current ? q.data : undefined;

  // Последние показанные результаты: пока новые не пришли, уточнение запроса не стирает экран (мигание на букву).
  const [shown, setShown] = useState<{ query: string; data: SearchResponse } | null>(null);
  if (fresh && (shown?.data !== fresh || shown.query !== typed)) setShown({ data: fresh, query: typed });
  const staleCandidate = !fresh && wanted && shown !== null && isRefinement(shown.query, typed);
  const [expiredFor, setExpiredFor] = useState('');
  useEffect(() => {
    if (!staleCandidate) return;
    const timer = setTimeout(() => setExpiredFor(typed), STALE_KEEP_MS);
    return () => clearTimeout(timer);
  }, [staleCandidate, typed]);
  const keepStale = staleCandidate && expiredFor !== typed && !(current && q.error);
  const data = fresh ?? (keepStale ? shown?.data : undefined);

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
    stale: fresh === undefined && data !== undefined,
    retrying: current && (missing.length > 0 || (q.isFetching && q.failureCount > 0)),
  };
}
