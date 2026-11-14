import { useVirtualizer } from '@tanstack/react-virtual';
import type { Key, ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { useListGeometry } from './use-list-offset';

/** Точки перелома сетки карточек: ширина области → число колонок (как `grid-cols-2 sm:3 lg:4 xl:5/6`). */
export const GRID_BREAKPOINTS = { sm: 640, lg: 1024, xl: 1280 } as const;

/** Число колонок по ширине окна: 2 → 3 (sm) → 4 (lg) → `max` (xl: 5 или 6). */
export function gridColumns(width: number, max: 5 | 6 = 5): number {
  if (width >= GRID_BREAKPOINTS.xl) return max;
  if (width >= GRID_BREAKPOINTS.lg) return 4;
  if (width >= GRID_BREAKPOINTS.sm) return 3;
  return 2;
}

const subscribeResize = (cb: () => void) => {
  globalThis.addEventListener('resize', cb);
  return () => globalThis.removeEventListener('resize', cb);
};

/** Число колонок для текущей ширины окна (те же точки перелома, что у CSS-сетки). */
export function useGridColumns(max: 5 | 6 = 5): number {
  const width = useSyncExternalStore(
    subscribeResize,
    () => globalThis.innerWidth,
    () => 1024,
  );
  return gridColumns(width, max);
}

const GAP = 16;

type Props = {
  count: number;
  columns: number;
  /** Высота строки сетки (без зазора) по ширине ячейки. */
  rowHeight: (cellWidth: number) => number;
  overscan?: number;
  getKey: (index: number) => Key;
  renderCell: (index: number) => ReactNode;
  className?: string;
  'data-testid'?: string;
};

/**
 * Виртуальная сетка карточек поверх общего контейнера прокрутки. Виртуализируются строки; число колонок
 * задаёт вызывающий код (`useGridColumns`). Ячейки одной строки одинаковой высоты — измерять не нужно.
 */
export function VirtualGrid({ count, columns, rowHeight, overscan = 3, getKey, renderCell, className, ...rest }: Props) {
  'use no memo'; // useVirtualizer возвращает функции, которые нельзя мемоизировать.
  const { margin, ref, scroll, width } = useListGeometry();
  const cellWidth = Math.max(0, (width - GAP * (columns - 1)) / columns);
  const height = rowHeight(cellWidth);
  const rows = Math.ceil(count / columns);
  // eslint-disable-next-line react-hooks/incompatible-library -- компонент помечен 'use no memo'
  const virtualizer = useVirtualizer({
    count: rows,
    estimateSize: () => height + GAP,
    getItemKey: row => getKey(row * columns),
    getScrollElement: () => scroll,
    overscan,
    scrollMargin: margin,
  });
  return (
    <div
      className={className}
      data-testid={rest['data-testid']}
      ref={ref}
      role="list"
      style={{ height: Math.max(0, virtualizer.getTotalSize() - margin - GAP), position: 'relative' }}
    >
      {virtualizer.getVirtualItems().map(row => (
        <div
          data-row={row.index}
          key={row.key}
          style={{
            display: 'grid',
            gap: GAP,
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            height,
            left: 0,
            position: 'absolute',
            top: 0,
            transform: `translateY(${row.start - margin}px)`,
            width: '100%',
          }}
        >
          {Array.from({ length: Math.min(columns, count - row.index * columns) }, (_, c) => {
            const index = row.index * columns + c;
            return (
              <div key={getKey(index)} role="listitem">
                {renderCell(index)}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
