import { AppNavLink } from '@/components/app-nav-link';
import { useT } from '@/lib/i18n/provider';
import type { NavItem } from '@/lib/nav/items';

const mobileTab =
  'flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium text-gray hover:text-black dark:hover:text-white aria-[current=page]:text-accent aria-[current=page]:font-bold aria-[current=page]:[&_svg]:stroke-[2.5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

/** Нижняя панель вкладок (мобильная, до `sm`). */
export function MobileTabBar({ items }: { items: readonly NavItem[] }) {
  const t = useT();
  return (
    // In-flow (не position: fixed): при запуске с домашнего экрана iOS фиксированный контейнер
    // может остаться слишком коротким, и панель «зависала» над мёртвой полосой.
    <nav
      aria-label={t('nav.primary')}
      className="border-divider/70 dark:border-divider-dark/70 relative z-30 flex shrink-0 border-t bg-white pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] sm:hidden dark:bg-[#181818]"
      data-testid="mobile-tab-bar"
      style={{ viewTransitionName: 'mobile-nav' }}
    >
      {items.map(({ end, icon: Icon, label, to }) => (
        <AppNavLink aria-label={t(label)} className={mobileTab} end={end} key={to} to={to}>
          <Icon className="size-5" />
          <span>{t(label)}</span>
        </AppNavLink>
      ))}
    </nav>
  );
}
