import * as Ariakit from '@ariakit/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

export type TabItem = {
  id: string;
  label: ReactNode;
  /** Если задан — вкладка является ссылкой (маршрут хранит выбор); иначе выбор через `onSelect`. */
  to?: string;
  'data-testid'?: string;
};

type Props = {
  items: readonly TabItem[];
  selectedId: string;
  onSelect?: (id: string) => void;
  'aria-label': string;
  className?: string;
};

const tab =
  'inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:h-11';

/**
 * Прокручивает ближайшего по горизонтали прокручиваемого предка так, чтобы `el` был виден целиком. Только по горизонтали:
 * `scrollIntoView` сдвинул бы и страницу (например, при восстановлении позиции прокрутки после «назад»).
 */
export function revealHorizontally(el: HTMLElement): void {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollWidth <= p.clientWidth || !/(auto|scroll)/.test(getComputedStyle(p).overflowX)) continue;
    const box = p.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left < box.left) p.scrollLeft -= box.left - r.left;
    else if (r.right > box.right) p.scrollLeft += r.right - box.right;
    return;
  }
}

/** Вкладки (Ariakit Tab): `role="tablist"`, стрелки переключают фокус. Вкладка со ссылкой `to` навигирует по клику. */
export function Tabs({ items, selectedId, onSelect, className, ...rest }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  // Строка вкладок может прокручиваться по горизонтали (узкий экран): выбранная вкладка всегда в поле зрения.
  useEffect(() => {
    // Ищем по id вкладки, а не по `aria-selected`: Ariakit выставляет его уже после нашего эффекта.
    const el = listRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(selectedId)}"]`);
    if (el) revealHorizontally(el);
  }, [selectedId]);
  return (
    <Ariakit.TabProvider selectedId={selectedId} setSelectedId={id => id && onSelect?.(id)}>
      <Ariakit.TabList className={cn('flex flex-wrap gap-2', className)} ref={listRef} {...rest}>
        {items.map(({ id, label, to, ...attrs }) => (
          <Ariakit.Tab
            className={cn(
              tab,
              id === selectedId
                ? 'bg-accent text-white'
                : 'border-divider dark:border-divider-dark text-muted hover:bg-card dark:hover:bg-card-dark border hover:text-black dark:hover:text-white',
            )}
            id={id}
            key={id}
            render={to ? <Link to={to} /> : undefined}
            {...attrs}
          >
            {label}
          </Ariakit.Tab>
        ))}
      </Ariakit.TabList>
    </Ariakit.TabProvider>
  );
}
