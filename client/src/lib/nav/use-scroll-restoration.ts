import { useLayoutEffect, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router';
import { lifecycle } from '@/lib/platform/lifecycle';

/** Сколько ждём, пока контент дорисуется до нужной высоты, прежде чем отпустить прокрутку. */
export const RESTORE_TIMEOUT_MS = 3000;

/**
 * Горизонтально прокручиваемая область экрана (ряд карточек): её позиция тоже возвращается «назад».
 * Значение — имя области, уникальное в пределах экрана.
 */
export const SCROLL_X_ATTR = 'data-scroll-x';

/** Позиция экрана: вертикальная прокрутка оболочки и горизонтальные — областей с `SCROLL_X_ATTR`. */
export type Position = { top: number; x: Record<string, number> };

export const POSITIONS_KEY = 'nimbus.scroll.positions';
/** Сколько записей истории помним (старые вытесняются). */
export const MAX_POSITIONS = 200;

const storage = (): Storage | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

/** Ключ первой записи, открытой загрузкой страницы: у любой такой записи он один, поэтому в хранилище не идёт. */
const INITIAL_KEY = 'default';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Запись из хранилища — только осмысленные числа: повреждённое не должно давать ложных целей прокрутки. */
function sanitize(v: unknown): Position | null {
  const p = v as Partial<Position> | null;
  if (!p || !finite(p.top)) return null;
  const x = typeof p.x === 'object' && p.x !== null ? Object.entries(p.x).filter(([, left]) => finite(left)) : [];
  return { top: p.top, x: Object.fromEntries(x) };
}

function load(): Map<string, Position> {
  try {
    const raw = storage()?.getItem(POSITIONS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return new Map();
    const entries = list.flatMap((item: unknown) => {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || item[0] === INITIAL_KEY) return [];
      const pos = sanitize(item[1]);
      return pos ? [[item[0], pos] as const] : [];
    });
    return new Map(entries);
  } catch {
    // Повреждённая запись или хранилище недоступно — позиции просто не переживут перезагрузку.
    return new Map();
  }
}

/**
 * Позиции по ключу записи истории (`location.key`). В `sessionStorage`: ключи записей react-router хранит в
 * `history.state`, они переживают перезагрузку и выгрузку приложения системой (iOS) — «назад» после неё тоже
 * возвращает позицию. Кроме первой записи вкладки: её ключ `default` совпал бы с ключом любой другой страницы,
 * открытой загрузкой (адрес набран вручную).
 */
let positions = load();

function persistPositions(): void {
  try {
    const list = [...positions].filter(([key]) => key !== INITIAL_KEY);
    storage()?.setItem(POSITIONS_KEY, JSON.stringify(list));
  } catch {
    // Хранилище переполнено или недоступно — не страшно, позиции останутся в памяти.
  }
}
// Ушли в фон (iOS может выгрузить приложение без `pagehide`) — записать. Подписка на всё время жизни вкладки.
lifecycle().on('background', persistPositions);

function entryFor(key: string, init: Position): Position {
  positions.delete(key); // свежая запись — в конец, вытесняются самые старые
  positions.set(key, init);
  while (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value as string);
  return init;
}

/** Для тестов: забыть позиции (и перечитать их из хранилища). */
export function resetScrollPositions(reload = false): void {
  positions = reload ? load() : new Map();
  current = null;
}

let pending: number | null = null;
/** Запись истории, на которой стоит оболочка: при замене (REPLACE) её позиция больше не нужна. */
let current: string | null = null;

/**
 * Следующий переход вперёд (не «назад») начнётся с этой позиции, а не сверху: экран, который сам помнит свою прокрутку
 * (поиск), вызывает это при монтировании — его layout-эффект срабатывает раньше эффекта оболочки.
 */
export function restoreScrollOnce(top: number): void {
  pending = top > 0 ? top : null;
}

/**
 * Позиции прокрутки по записи истории: «назад/вперёд» возвращает экран как был, новый переход начинает сверху.
 * Скроллится контейнер, а не `window`, поэтому встроенного восстановления браузера недостаточно.
 *
 * Layout-эффект: позиция ставится в том же коммите, где смонтирован экран, — до первой отрисовки, без кадра
 * «экран сверху → прыжок». Позиция запоминается только по событиям `scroll`: прежний экран снимает слушатель в том же
 * коммите, где его DOM сменился, поэтому подрезка прокрутки под новый (короткий) экран ему уже не достаётся.
 * Контент может дорисоваться позже — позиция применяется, пока страница не станет достаточно высокой.
 */
export function useScrollRestoration(ref: RefObject<HTMLElement | null>): void {
  const { key } = useLocation();
  const type = useNavigationType();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const saved = type === 'POP' ? positions.get(key) : undefined;
    const top = type === 'POP' ? (saved?.top ?? 0) : (pending ?? 0);
    pending = null;
    // Замена записи (набор запроса в поиске меняет `?q=` без истории): прежней записи в истории больше нет.
    if (type === 'REPLACE' && current !== null && current !== key) positions.delete(current);
    current = key;
    const entry = entryFor(key, { top, x: { ...saved?.x } });
    // Что ещё не удалось применить: контент может быть короче нужной позиции, ряд карточек — ещё не нарисован.
    let restoreTop = top > 0;
    const restoreX = new Map(Object.entries(entry.x).filter(([, left]) => left > 0));
    if (!restoreTop) el.scrollTop = 0;

    const area = (name: string) => el.querySelector<HTMLElement>(`[${SCROLL_X_ATTR}="${CSS.escape(name)}"]`);
    const apply = () => {
      if (restoreTop) {
        el.scrollTop = top;
        if (el.scrollTop >= top - 1) restoreTop = false;
      }
      for (const [name, left] of restoreX) {
        const node = area(name);
        if (!node) continue;
        node.scrollLeft = left;
        if (node.scrollLeft >= left - 1) restoreX.delete(name);
      }
    };
    apply();
    const restoring = () => restoreTop || restoreX.size > 0;
    const observer = typeof ResizeObserver === 'undefined' || !restoring() ? null : new ResizeObserver(apply);
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    const stop = () => {
      restoreTop = false;
      restoreX.clear();
      observer?.disconnect();
    };
    // Пользователь сам начал скроллить (колесо, палец, полоса прокрутки, клавиши) — больше не вмешиваемся.
    const interactions = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const type of interactions) el.addEventListener(type, stop, { passive: true });
    const timer = setTimeout(stop, RESTORE_TIMEOUT_MS);

    // `scroll` не всплывает, но проходит фазу перехвата: так ловятся и горизонтальные ряды внутри экрана.
    const onScroll = (e: Event) => {
      if (e.target === el) {
        if (!restoreTop) entry.top = el.scrollTop;
        return;
      }
      const node = e.target instanceof HTMLElement ? e.target : null;
      const name = node?.getAttribute(SCROLL_X_ATTR);
      if (node && name && !restoreX.has(name)) entry.x[name] = node.scrollLeft;
    };
    el.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
      el.removeEventListener('scroll', onScroll, { capture: true });
      for (const type of interactions) el.removeEventListener(type, stop);
    };
  }, [key, type, ref]);
}
