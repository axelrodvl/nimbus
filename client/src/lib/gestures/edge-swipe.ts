// Распознавание жеста «назад» — смахивания от левого края (iOS standalone: кнопки браузера нет).
// Чистая функция над потоком точек касания: DOM и React не нужны.

export type EdgeSwipeConfig = {
  /** Ширина зоны у левого края, в которой жест может начаться, px. */
  edge: number;
  /** Сдвиг по X, после которого жест засчитывается, px. */
  distance: number;
  /** Либо скорость (px/мс) при сдвиге не меньше `minDistance`. */
  velocity: number;
  minDistance: number;
  /** Вертикальное движение, при котором жест — это прокрутка, а не «назад»: |dy| > |dx| * ratio. */
  verticalRatio: number;
  /** Сдвиг, с которого направление считается определённым, px. */
  slop: number;
};

export const EDGE_SWIPE: EdgeSwipeConfig = {
  distance: 96,
  edge: 24,
  minDistance: 40,
  slop: 10,
  velocity: 0.5,
  verticalRatio: 0.75,
};

export type EdgeSwipeState =
  | { phase: 'idle' }
  /** Касание у края, направление ещё не ясно. */
  | { phase: 'pending'; x0: number; y0: number; t0: number }
  /** Горизонтальное движение: экран следует за пальцем (`dx` ≥ 0). */
  | { phase: 'dragging'; x0: number; y0: number; t0: number; dx: number; vx: number; lastX: number; lastT: number }
  | { phase: 'ignored' };

export type EdgeSwipeResult = 'commit' | 'cancel';

export const idleSwipe: EdgeSwipeState = { phase: 'idle' };

/** Касание началось: жест возможен, только если оно у левого края. */
export function swipeStart(x: number, y: number, t: number, cfg = EDGE_SWIPE): EdgeSwipeState {
  return x <= cfg.edge ? { phase: 'pending', t0: t, x0: x, y0: y } : { phase: 'ignored' };
}

/** Движение пальца. Вертикальное движение до определения направления отменяет жест. */
export function swipeMove(s: EdgeSwipeState, x: number, y: number, t: number, cfg = EDGE_SWIPE): EdgeSwipeState {
  if (s.phase === 'idle' || s.phase === 'ignored') return s;
  const dx = x - s.x0;
  const dy = y - s.y0;
  if (s.phase === 'pending') {
    if (Math.abs(dx) < cfg.slop && Math.abs(dy) < cfg.slop) return s;
    if (dx <= 0 || Math.abs(dy) > Math.abs(dx) * cfg.verticalRatio) return { phase: 'ignored' };
    return { dx, lastT: t, lastX: x, phase: 'dragging', t0: s.t0, vx: 0, x0: s.x0, y0: s.y0 };
  }
  const dt = t - s.lastT;
  const vx = dt > 0 ? (x - s.lastX) / dt : s.vx;
  return { ...s, dx: Math.max(0, dx), lastT: t, lastX: x, vx };
}

/** Палец отпущен: `commit` — вернуться назад; `cancel` — экран возвращается на место; `null` — жеста не было. */
export function swipeEnd(s: EdgeSwipeState, cfg = EDGE_SWIPE): EdgeSwipeResult | null {
  if (s.phase !== 'dragging') return null;
  if (s.dx >= cfg.distance) return 'commit';
  return s.vx >= cfg.velocity && s.dx >= cfg.minDistance ? 'commit' : 'cancel';
}

/** Должен ли жест уступить: касание внутри элемента, который сам обрабатывает горизонтальные жесты. */
export function yieldsToOwner(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as Element;
  if (el.closest('[data-gesture="own"]')) return true;
  // Горизонтально прокручиваемые области (карусели) и ползунки.
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.matches('input[type="range"], [role="slider"], [role="dialog"]')) return true;
    if (node.scrollWidth > node.clientWidth && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}
