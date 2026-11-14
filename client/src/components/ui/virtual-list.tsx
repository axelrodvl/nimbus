import { useVirtualizer } from '@tanstack/react-virtual';
import type { Key, ReactNode } from 'react';
import { useListGeometry } from './use-list-offset';

type Props = {
  count: number;
  /** Высота строки с зазором. Строки одинаковые — измерять их не нужно, прокрутка не «прыгает». */
  rowHeight: number;
  /** Сколько строк рисовать за краями видимой области. */
  overscan?: number;
  getKey: (index: number) => Key;
  renderRow: (index: number) => ReactNode;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
};

/**
 * Виртуальный список поверх общего контейнера прокрутки оболочки (не вложенного): в DOM — только видимые
 * строки и `overscan`. Полная высота известна сразу, поэтому восстановление прокрутки работает с первого кадра.
 */
export function VirtualList({ count, rowHeight, overscan = 8, getKey, renderRow, className, ...rest }: Props) {
  'use no memo'; // useVirtualizer возвращает функции, которые нельзя мемоизировать.
  const { margin, ref, scroll } = useListGeometry();
  // eslint-disable-next-line react-hooks/incompatible-library -- компонент помечен 'use no memo'
  const virtualizer = useVirtualizer({
    count,
    estimateSize: () => rowHeight,
    getItemKey: getKey,
    getScrollElement: () => scroll,
    overscan,
    scrollMargin: margin,
  });
  return (
    <div
      aria-label={rest['aria-label']}
      className={className}
      data-testid={rest['data-testid']}
      ref={ref}
      role="list"
      style={{ height: Math.max(0, virtualizer.getTotalSize() - margin), position: 'relative' }}
    >
      {virtualizer.getVirtualItems().map(item => (
        <div
          data-index={item.index}
          key={item.key}
          role="listitem"
          style={{
            height: rowHeight,
            left: 0,
            position: 'absolute',
            top: 0,
            transform: `translateY(${item.start - margin}px)`,
            width: '100%',
          }}
        >
          {renderRow(item.index)}
        </div>
      ))}
    </div>
  );
}
