import * as Ariakit from '@ariakit/react';
import type { ReactNode } from 'react';
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

/** Вкладки (Ariakit Tab): `role="tablist"`, стрелки переключают фокус. Вкладка со ссылкой `to` навигирует по клику. */
export function Tabs({ items, selectedId, onSelect, className, ...rest }: Props) {
  return (
    <Ariakit.TabProvider selectedId={selectedId} setSelectedId={id => id && onSelect?.(id)}>
      <Ariakit.TabList className={cn('flex flex-wrap gap-2', className)} {...rest}>
        {items.map(({ id, label, to, ...attrs }) => (
          <Ariakit.Tab
            className={cn(
              tab,
              id === selectedId
                ? 'bg-accent text-white'
                : 'border-divider dark:border-divider-dark text-gray hover:bg-card dark:hover:bg-card-dark border hover:text-black dark:hover:text-white',
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
