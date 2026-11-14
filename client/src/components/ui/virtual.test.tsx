import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockLayout, ScrollHost } from '@/test/layout';
import { gridColumns, useGridColumns, VirtualGrid } from './virtual-grid';
import { VirtualList } from './virtual-list';

let restore: () => void;
beforeEach(() => {
  restore = mockLayout({ height: 600, width: 1000 });
});
afterEach(() => restore());

const rows = () => screen.queryAllByTestId('row');

describe('VirtualList', () => {
  const list = (count: number) => (
    <ScrollHost>
      <VirtualList
        count={count}
        getKey={i => i}
        overscan={5}
        renderRow={i => <div data-testid="row">row {i}</div>}
        rowHeight={50}
      />
    </ScrollHost>
  );

  it('10 000 элементов: в DOM только видимые строки и overscan', () => {
    render(list(10_000));
    // 600 / 50 = 12 видимых + overscan 5 снизу.
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThanOrEqual(12 + 5 + 1);
    expect(screen.getByRole('list')).toHaveStyle({ height: '500000px' });
  });

  it('прокрутка к середине показывает элементы из середины списка', () => {
    render(list(10_000));
    const host = screen.getByTestId('scroll-host');
    act(() => {
      host.scrollTop = 250_000; // строка 5000
      host.dispatchEvent(new Event('scroll'));
    });
    const texts = rows().map(r => r.textContent);
    expect(texts).toContain('row 5000');
    expect(texts).not.toContain('row 0');
    expect(rows().length).toBeLessThanOrEqual(12 + 5 * 2 + 2);
  });

  it('пустой список не рисует строк', () => {
    render(list(0));
    expect(rows()).toHaveLength(0);
  });
});

describe('VirtualGrid', () => {
  const grid = (count: number, columns: number) => (
    <ScrollHost>
      <VirtualGrid
        columns={columns}
        count={count}
        getKey={i => i}
        overscan={1}
        renderCell={i => <div data-testid="row">cell {i}</div>}
        rowHeight={w => w + 100}
      />
    </ScrollHost>
  );

  it('виртуализирует строки: 10 000 ячеек в 4 колонки — в DOM лишь несколько строк', () => {
    render(grid(10_000, 4));
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThanOrEqual(4 * 4);
    expect(rows()[0]).toHaveTextContent('cell 0');
  });

  it('последняя строка неполная: лишних ячеек нет', () => {
    render(grid(5, 4));
    expect(rows()).toHaveLength(5);
  });

  it('число колонок по точкам перелома 2/3/4/5|6', () => {
    expect([500, 640, 1024, 1280].map(w => gridColumns(w))).toEqual([2, 3, 4, 5]);
    expect(gridColumns(1500, 6)).toBe(6);
  });

  it('useGridColumns следует за шириной окна', () => {
    function Probe() {
      return <p data-testid="cols">{useGridColumns(6)}</p>;
    }
    const original = globalThis.innerWidth;
    Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 700, writable: true });
    render(<Probe />);
    expect(screen.getByTestId('cols')).toHaveTextContent('3');
    act(() => {
      Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1400, writable: true });
      globalThis.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByTestId('cols')).toHaveTextContent('6');
    Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: original, writable: true });
  });
});
