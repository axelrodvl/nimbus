'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api/client';
import type { Schemas } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';

export type SearchResponse = Schemas['SearchResponse'];
export type SearchStatus = 'idle' | 'loading' | 'success' | 'error';

type Options = {
  limit?: number;
  debounceMs?: number;
};

type View = {
  key: string;
  status: 'success' | 'error';
  data: SearchResponse | undefined;
  error?: string;
};

const DEFAULT_LIMIT = 8;
const DEFAULT_DEBOUNCE_MS = 350;

// Кэш результатов на время сессии вкладки: повторный ввод того же запроса мгновенный.
// Ответы с частичными ошибками (`errors` не пуст) не кэшируются, чтобы их можно было повторить.
const cache = new Map<string, SearchResponse>();

function cacheKey(query: string, limit: number) {
  return query ? `${limit}:${query.toLowerCase()}` : '';
}

export function clearSearchCache() {
  cache.clear();
}

export type UseSearch = {
  status: SearchStatus;
  /** Последние известные результаты (при `stale` — для предыдущего запроса). */
  data: SearchResponse | undefined;
  /** Идёт новая загрузка, а показаны результаты предыдущего запроса. */
  stale: boolean;
  error: string | undefined;
  retry: () => void;
};

export function useSearch(query: string, { limit = DEFAULT_LIMIT, debounceMs = DEFAULT_DEBOUNCE_MS }: Options = {}) {
  const trimmed = query.trim();
  const key = cacheKey(trimmed, limit);

  const [debounced, setDebounced] = useState(trimmed);
  const [view, setView] = useState<View | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  // Debounce: закэшированный запрос применяется без задержки.
  useEffect(() => {
    const delay = cache.has(cacheKey(trimmed, limit)) ? 0 : debounceMs;
    const timer = setTimeout(() => setDebounced(trimmed), delay);
    return () => clearTimeout(timer);
  }, [trimmed, limit, debounceMs]);

  // Загрузка; устаревший запрос отменяется при смене `debounced`.
  useEffect(() => {
    if (!debounced) return;
    const k = cacheKey(debounced, limit);
    if (cache.has(k)) return;

    const controller = new AbortController();
    api
      .GET('/api/search', { params: { query: { limit, q: debounced } }, signal: controller.signal })
      .then(res => {
        const data = unwrap(res);
        if (data.errors.length === 0) cache.set(k, data);
        setView({ data, key: k, status: 'success' });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setView(prev => ({
          data: prev?.data,
          error: e instanceof Error ? e.message : 'Не удалось выполнить поиск',
          key: k,
          status: 'error',
        }));
      });
    return () => controller.abort();
  }, [debounced, limit, attempt]);

  function retry() {
    setView(undefined);
    setDebounced(trimmed);
    setAttempt(n => n + 1);
  }

  if (!key) return { data: undefined, error: undefined, retry, stale: false, status: 'idle' } satisfies UseSearch;

  const cached = cache.get(key);
  const current = view?.key === key ? view : undefined;
  const data = cached ?? view?.data;
  const status: SearchStatus = cached ? 'success' : (current?.status ?? 'loading');

  return {
    data,
    error: current?.error,
    retry,
    stale: status === 'loading' && data !== undefined,
    status,
  } satisfies UseSearch;
}
