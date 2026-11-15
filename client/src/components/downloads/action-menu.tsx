import * as Ariakit from '@ariakit/react';
import { MoreHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import { menuItemClass } from '@/components/library/row-menu';

export type MenuAction = { id: string; label: string; onClick?: () => void; to?: string; danger?: boolean };

/** Меню «…» строки: вторичные действия (на узком экране — единственный способ до них добраться). */
export function ActionMenu({
  label,
  actions,
  testId,
}: {
  label: string;
  actions: readonly MenuAction[];
  testId?: string;
}) {
  if (actions.length === 0) return null;
  return (
    <Ariakit.MenuProvider>
      <Ariakit.MenuButton
        aria-label={label}
        className="text-gray hover:bg-card dark:hover:bg-card-dark focus-visible:ring-accent/40 flex size-9 shrink-0 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none pointer-coarse:size-11"
        data-testid={testId ?? 'row-menu'}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </Ariakit.MenuButton>
      <Ariakit.Menu
        className="border-divider dark:border-divider-dark z-30 min-w-48 rounded-lg border bg-white p-1 shadow-lg dark:bg-black"
        gutter={4}
        portal
      >
        {actions.map(a => (
          <Ariakit.MenuItem
            className={`${menuItemClass} ${a.danger ? 'text-danger-fg' : ''}`}
            data-testid={`menu-${a.id}`}
            key={a.id}
            onClick={a.onClick}
            render={a.to ? <Link to={a.to} /> : undefined}
          >
            {a.label}
          </Ariakit.MenuItem>
        ))}
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
}
