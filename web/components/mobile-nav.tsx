import { Home, Library, Search, Settings } from 'lucide-react';
import { getT } from '@/lib/i18n/server';
import { NavLink } from './ui/nav-link';

const mobileTab =
  'flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium text-gray hover:text-black dark:hover:text-white aria-[current=page]:text-accent aria-[current=page]:font-bold aria-[current=page]:[&_svg]:stroke-[2.5]';

export async function MobileTabBar() {
  const t = await getT();
  return (
    // In-flow (not position: fixed): on iOS home-screen launch the fixed containing block can be
    // stale and too short, which left the bar floating above a dead strip.
    <nav
      aria-label={t('nav.primary')}
      style={{ viewTransitionName: 'mobile-nav' }}
      className="border-divider/70 dark:border-divider-dark/70 relative z-30 flex shrink-0 border-t bg-white pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] sm:hidden dark:bg-[#181818]"
    >
      <NavLink href="/" aria-label={t('nav.home')} className={mobileTab}>
        <Home className="h-5 w-5" />
        <span>{t('nav.home')}</span>
      </NavLink>
      <NavLink href="/search" aria-label={t('nav.search')} className={mobileTab}>
        <Search className="h-5 w-5" />
        <span>{t('nav.search')}</span>
      </NavLink>
      <NavLink href="/library" aria-label={t('nav.library')} className={mobileTab}>
        <Library className="h-5 w-5" />
        <span>{t('nav.library')}</span>
      </NavLink>
      <NavLink href="/settings" aria-label={t('nav.settings')} className={mobileTab}>
        <Settings className="h-5 w-5" />
        <span>{t('nav.settings')}</span>
      </NavLink>
    </nav>
  );
}
