/** Минимальная длина запроса, с которой уходит сеть. */
export const MIN_QUERY_LENGTH = 2;
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_STALE_MS = 5 * 60_000;
/** Сколько результатов на секцию показывает локальный поиск. */
export const LOCAL_LIMIT = 5;

/** Ключ кэша: trim, схлопывание пробелов, нижний регистр. В URL и поле ввода остаётся исходный текст. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}
