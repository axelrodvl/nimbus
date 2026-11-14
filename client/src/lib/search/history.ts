import { useSyncExternalStore } from 'react';

export const HISTORY_KEY = 'nimbus:search-history';
export const HISTORY_LIMIT = 10;

const listeners = new Set<() => void>();
let cache: { raw: string | null; value: string[] } = { raw: null, value: [] };

function read(): string[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(HISTORY_KEY);
  } catch {
    // Хранилище недоступно (приватный режим): история пуста.
  }
  if (raw === cache.raw) return cache.value;
  let value: string[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) value = parsed.filter((x): x is string => typeof x === 'string').slice(0, HISTORY_LIMIT);
  } catch {
    // Повреждённое значение — как пустая история.
  }
  cache = { raw, value };
  return value;
}

function write(items: string[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(HISTORY_KEY);
    else localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch {
    // Не удалось сохранить: история живёт до перезагрузки только если хранилище доступно — иначе её нет.
  }
  listeners.forEach(l => l());
}

/** Последние запросы, новые первыми. */
export const readHistory = read;

/** Добавляет запрос в начало; повтор (без учёта регистра и лишних пробелов) переносится наверх; максимум 10. */
export function addToHistory(query: string): void {
  const text = query.trim().replace(/\s+/g, ' ');
  if (!text) return;
  const key = text.toLowerCase();
  write([text, ...read().filter(q => q.toLowerCase() !== key)].slice(0, HISTORY_LIMIT));
}

export function clearHistory(): void {
  write([]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === HISTORY_KEY || e.key === null) listener();
  };
  globalThis.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener('storage', onStorage);
  };
}

export function useSearchHistory(): string[] {
  return useSyncExternalStore(subscribe, read, () => []);
}
