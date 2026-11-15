// Перетаскивание нижнего листа вниз: чистая логика решения «закрыть или вернуть на место».

export type SheetRelease = 'close' | 'snap';

/** Доля высоты листа, после которой отпускание закрывает его. */
export const SHEET_CLOSE_FRACTION = 0.3;
/** Скорость (px/мс) броска вниз, закрывающая лист независимо от пройденного пути (инерция). */
export const SHEET_CLOSE_VELOCITY = 0.6;

/** Сопротивление при попытке тянуть лист вверх: за верхнюю точку он идёт «резиной». */
export function sheetOffset(dy: number): number {
  return dy >= 0 ? dy : dy / 6;
}

/**
 * Решение при отпускании. Точки фиксации две: открыт (0) и закрыт (высота листа); к ближайшей лист идёт
 * с учётом скорости: быстрый бросок вниз закрывает, бросок вверх возвращает.
 */
export function sheetRelease(dy: number, velocity: number, height: number): SheetRelease {
  if (velocity <= -SHEET_CLOSE_VELOCITY) return 'snap';
  if (velocity >= SHEET_CLOSE_VELOCITY && dy > 8) return 'close';
  return height > 0 && dy >= height * SHEET_CLOSE_FRACTION ? 'close' : 'snap';
}

/** Оценка скорости по последним двум точкам (px/мс); 0, если интервала нет. */
export function velocityOf(y0: number, t0: number, y1: number, t1: number): number {
  return t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;
}
