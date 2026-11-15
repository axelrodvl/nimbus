import { LogOut, Search } from 'lucide-react';
import { AppNavLink } from '@/components/app-nav-link';
import { DownloadsBadge } from '@/components/nav-badge';
import { OfflineQueueIndicator } from '@/components/offline/queue-indicator';
import { ConnectionIndicator } from '@/components/connection-indicator';
import { useCommandPalette } from '@/components/search/command-palette';
import { ShortcutHint, useShortcutText } from '@/components/shortcut-hint';
import { SyncStatus } from '@/components/sync-status';
import { MusicNote } from '@/components/ui/music-note';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { session } from '@/lib/auth';
import { useT } from '@/lib/i18n/provider';
import type { NavItem } from '@/lib/nav/items';

export const sidebarLink =
  'flex items-center justify-center gap-3 rounded-md p-2 text-sm tracking-tight lg:justify-start lg:px-3 text-muted not-aria-[current=page]:hover:text-black dark:not-aria-[current=page]:hover:text-white aria-[current=page]:bg-white/10 aria-[current=page]:font-bold aria-[current=page]:text-black aria-[current=page]:dark:text-white aria-[current=page]:[&_svg]:stroke-[2.5] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none';

/** Боковая панель (от `sm`): узкая с иконками, на `lg` — с подписями. */
export function Sidebar({ items }: { items: readonly NavItem[] }) {
  const t = useT();
  const palette = useCommandPalette();
  const shortcut = useShortcutText();
  return (
    <aside className="hidden w-[4.5rem] shrink-0 flex-col gap-2 p-2 sm:flex lg:w-[17.5rem]" data-testid="sidebar">
      <div className="bg-card dark:bg-card-dark rounded-lg p-3 lg:p-4">
        <div className="mb-4 hidden items-center justify-between lg:flex">
          <AppNavLink
            aria-label={t('nav.homeLink')}
            className="text-accent-fg inline-flex items-center gap-2 px-1 text-xl font-bold tracking-tight"
            end
            to="/"
          >
            <MusicNote className="text-accent-fg" size={24} />
            <span>Nimbus</span>
          </AppNavLink>
        </div>
        <button
          aria-haspopup="dialog"
          aria-label={`${t('palette.label')} ${shortcut}`}
          className="text-muted focus-visible:ring-accent/40 mb-3 flex w-full items-center justify-center gap-2 rounded-md border border-white/10 p-2 text-sm hover:text-black focus-visible:ring-2 focus-visible:outline-none lg:justify-start lg:px-3 dark:hover:text-white"
          data-testid="palette-button"
          onClick={palette.open}
          type="button"
        >
          <Search aria-hidden className="size-4" />
          <span className="hidden flex-1 truncate text-left lg:inline">{t('palette.label')}</span>{' '}
          <ShortcutHint className="hidden font-mono text-xs lg:inline" />
        </button>
        <nav aria-label={t('nav.primary')} className="flex flex-col gap-1 text-sm font-medium">
          {items.map(({ badge, end, icon: Icon, label, to }) => (
            <AppNavLink className={sidebarLink} end={end} key={to} to={to}>
              <span className="relative">
                <Icon className="size-5" />
                {badge === 'downloads' ? <DownloadsBadge /> : null}
              </span>
              <span className="sr-only truncate lg:not-sr-only lg:inline">{t(label)}</span>
            </AppNavLink>
          ))}
        </nav>
      </div>

      <div className="bg-card dark:bg-card-dark mt-auto flex flex-col gap-3 rounded-lg p-3 lg:px-4">
        <div className="flex flex-col items-center gap-2 lg:flex-row lg:justify-between">
          <ConnectionIndicator labelClassName="hidden lg:inline" showLabel />
          <OfflineQueueIndicator />
          <ThemeToggle variant="inline" />
        </div>
        <div className="flex justify-center lg:justify-start">
          <SyncStatus labelClassName="hidden lg:inline" />
        </div>
        <div className="hidden items-center justify-end gap-2 lg:flex">
          <button
            aria-label={t('login.logout')}
            className="text-gray focus-visible:ring-accent/40 rounded-full p-1.5 hover:text-black focus-visible:ring-2 focus-visible:outline-none dark:hover:text-white"
            onClick={() => void session.logout()}
            title={t('login.logout')}
            type="button"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
