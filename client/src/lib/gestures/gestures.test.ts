import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDGE_SWIPE, idleSwipe, swipeEnd, swipeMove, swipeStart, yieldsToOwner } from './edge-swipe';
import { createLongPress } from './long-press';

function drag(points: [number, number, number][]) {
  let s = swipeStart(points[0][0], points[0][1], points[0][2]);
  for (const [x, y, t] of points.slice(1)) s = swipeMove(s, x, y, t);
  return s;
}

describe('edge-swipe', () => {
  it('начало у края, сдвиг дальше порога → commit', () => {
    const s = drag([
      [5, 300, 0],
      [40, 305, 100],
      [120, 310, 400],
    ]);
    expect(s.phase).toBe('dragging');
    expect(swipeEnd(s)).toBe('commit');
  });

  it('быстрый короткий взмах (скорость) → commit', () => {
    const s = drag([
      [5, 300, 0],
      [30, 300, 20],
      [60, 300, 40],
    ]);
    expect(swipeEnd(s)).toBe('commit');
  });

  it('медленный и короткий сдвиг → cancel (экран возвращается)', () => {
    const s = drag([
      [5, 300, 0],
      [30, 300, 400],
      [50, 300, 900],
    ]);
    expect(swipeEnd(s)).toBe('cancel');
  });

  it('старт вне зоны края игнорируется', () => {
    const s = drag([
      [EDGE_SWIPE.edge + 1, 300, 0],
      [200, 300, 100],
    ]);
    expect(s.phase).toBe('ignored');
    expect(swipeEnd(s)).toBeNull();
  });

  it('вертикальное движение — это прокрутка: жест не начинается', () => {
    const s = drag([
      [5, 300, 0],
      [12, 340, 50],
    ]);
    expect(s.phase).toBe('ignored');
  });

  it('движение влево от края не начинает жест; мелкая дрожь не определяет направление', () => {
    expect(drag([[20, 300, 0], [0, 300, 30]]).phase).toBe('ignored');
    expect(drag([[5, 300, 0], [8, 303, 30]]).phase).toBe('pending');
  });

  it('состояние idle/ignored не меняется движением; end без жеста — null', () => {
    expect(swipeMove(idleSwipe, 50, 0, 1)).toBe(idleSwipe);
    expect(swipeEnd(idleSwipe)).toBeNull();
    expect(swipeEnd(swipeStart(5, 5, 0))).toBeNull();
  });

  it('dx не уходит в минус, если палец вернулся назад', () => {
    let s = drag([[5, 300, 0], [50, 300, 50]]);
    s = swipeMove(s, 2, 300, 100);
    expect(s.phase === 'dragging' && s.dx).toBe(0);
  });
});

describe('yieldsToOwner', () => {
  it('элемент с data-gesture="own" и ползунок — уступаем; обычный — нет', () => {
    document.body.innerHTML = '<div data-gesture="own"><span id="a"></span></div><input id="r" type="range"><p id="p"></p>';
    expect(yieldsToOwner(document.getElementById('a'))).toBe(true);
    expect(yieldsToOwner(document.getElementById('r'))).toBe(true);
    expect(yieldsToOwner(document.getElementById('p'))).toBe(false);
    expect(yieldsToOwner(null)).toBe(false);
  });
});

describe('long-press', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('срабатывает через 500 мс неподвижного касания; следующий click подавляется один раз', () => {
    const onTrigger = vi.fn();
    const lp = createLongPress({ onTrigger });
    lp.start(10, 20);
    vi.advanceTimersByTime(499);
    expect(onTrigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTrigger).toHaveBeenCalledWith({ x: 10, y: 20 });
    expect(lp.consumeClick()).toBe(true);
    expect(lp.consumeClick()).toBe(false);
  });

  it('сдвиг больше 10 px отменяет; небольшой — нет', () => {
    const onTrigger = vi.fn();
    const lp = createLongPress({ onTrigger });
    lp.start(0, 0);
    lp.move(6, 6);
    vi.advanceTimersByTime(500);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    lp.start(0, 0);
    lp.move(11, 0);
    vi.advanceTimersByTime(1000);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('отпускание раньше времени отменяет и click не подавляется', () => {
    const onTrigger = vi.fn();
    const lp = createLongPress({ onTrigger });
    lp.start(0, 0);
    vi.advanceTimersByTime(200);
    lp.end();
    vi.advanceTimersByTime(1000);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(lp.consumeClick()).toBe(false);
  });
});
