import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/**
 * Последний поиск этой вкладки: запрос и прокрутка результатов. Вкладка «Поиск» ведёт на него, а не на пустой экран:
 * вернулся — всё как было. Живёт в `sessionStorage` (переживает перезагрузку, у каждой вкладки браузера — свой).
 */
export type SearchSession = { query: string; scroll: number };

export const SESSION_KEY = 'nimbus.search.session';

function load(storage: Pick<Storage, 'getItem'> | undefined): SearchSession {
  try {
    const raw = storage?.getItem(SESSION_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<SearchSession>) : null;
    if (v && typeof v.query === 'string') return { query: v.query, scroll: Number(v.scroll) || 0 };
  } catch {
    // Повреждённая запись или хранилище недоступно (приватный режим) — начинаем с пустого поиска.
  }
  return { query: '', scroll: 0 };
}

const storage = (): Storage | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

export const searchSession = createStore<SearchSession>(() => load(storage()));

/** Прокрутка пишется не чаще раза в это время (событий `scroll` — десятки в секунду). */
export const PERSIST_SCROLL_MS = 250;
let persisted: SearchSession | null = null;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function persist(): void {
  clearTimeout(timer);
  timer = undefined;
  dirty = false;
  persisted = searchSession.getState();
  try {
    storage()?.setItem(SESSION_KEY, JSON.stringify(persisted));
  } catch {
    // Хранилище переполнено или недоступно: поиск просто не переживёт перезагрузку.
  }
}

/** Записать несохранённое сейчас (уход с экрана, `pagehide`). */
export function flushSearchSession(): void {
  if (dirty) persist();
}

searchSession.subscribe(s => {
  // Новый запрос — сразу (редкое событие); прокрутка — не чаще `PERSIST_SCROLL_MS`.
  if (s.query !== persisted?.query) {
    persist();
    return;
  }
  dirty = true;
  timer ??= setTimeout(flushSearchSession, PERSIST_SCROLL_MS);
});
globalThis.addEventListener?.('pagehide', flushSearchSession);

/** Запрос изменился: прокрутка прежнего к нему не относится. */
export function rememberQuery(query: string): void {
  const s = searchSession.getState();
  if (s.query !== query) searchSession.setState({ query, scroll: 0 });
}

/** Прокрутка результатов текущего запроса. */
export function rememberScroll(scroll: number): void {
  if (searchSession.getState().scroll !== scroll) searchSession.setState({ scroll });
}

export const searchHref = (query: string): string =>
  query.trim() ? `/search?q=${encodeURIComponent(query)}` : '/search';

/** Куда ведёт вкладка «Поиск»: на последний запрос. */
export const useSearchHref = (): string => useStore(searchSession, s => searchHref(s.query));

/** Для перезагрузки в тестах. */
export function reloadSearchSession(from: Pick<Storage, 'getItem'> | undefined = storage()): void {
  searchSession.setState(load(from), true);
}
