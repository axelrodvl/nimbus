import type { ComponentProps } from 'react';
import { NavLink } from 'react-router';
import { cn } from '@/lib/utils';

type Props = Omit<ComponentProps<typeof NavLink>, 'viewTransition' | 'className'> & { className?: string };

/** Ссылка навигации: активна на самом пути и на вложенных (`aria-current="page"`), переход — через View Transitions. */
export function AppNavLink({ className, ...props }: Props) {
  return <NavLink {...props} viewTransition className={cn(className)} />;
}
