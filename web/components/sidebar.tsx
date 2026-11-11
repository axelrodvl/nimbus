import { Home, Library, Search } from 'lucide-react';
import { ConnectionIndicator } from '@/components/connection-indicator';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { FastLink } from '@/components/ui/fast-link';
import { MusicNote } from '@/components/ui/music-note';
import { NavLink } from '@/components/ui/nav-link';

const sidebarLink =
  'flex items-center justify-center gap-3 rounded-md p-2 text-sm tracking-tight lg:justify-start lg:px-3 text-muted not-aria-[current=page]:hover:text-black dark:not-aria-[current=page]:hover:text-white aria-[current=page]:bg-white/10 aria-[current=page]:font-bold aria-[current=page]:text-black aria-[current=page]:dark:text-white aria-[current=page]:[&_svg]:stroke-[2.5]';

export function Sidebar() {
  return (
    <aside className="hidden w-[4.5rem] flex-col gap-2 p-2 sm:flex lg:w-[17.5rem]">
      <div className="bg-card dark:bg-card-dark rounded-lg p-3 lg:p-4">
        <div className="mb-4 hidden items-center justify-between lg:flex">
          <FastLink
            href="/"
            className="text-accent inline-flex items-center gap-2 px-1 text-xl font-bold tracking-tight"
            aria-label="Nimbus home"
          >
            <MusicNote size={24} className="text-accent" />
            <span>Nimbus</span>
          </FastLink>
        </div>
        <nav className="flex flex-col gap-1 text-sm font-medium">
          <NavLink href="/" aria-label="Home" className={sidebarLink}>
            <Home className="h-5 w-5" />
            <span className="hidden truncate lg:inline">Home</span>
          </NavLink>
          <NavLink href="/search" aria-label="Search" className={sidebarLink}>
            <Search className="h-5 w-5" />
            <span className="hidden truncate lg:inline">Search</span>
          </NavLink>
          <NavLink href="/library" aria-label="Library" className={sidebarLink}>
            <Library className="h-5 w-5" />
            <span className="hidden truncate lg:inline">Library</span>
          </NavLink>
        </nav>
      </div>

      <div className="bg-card dark:bg-card-dark mt-auto flex flex-col items-center gap-3 rounded-lg p-3 lg:flex-row lg:justify-between lg:px-4">
        <ConnectionIndicator showLabel />
        <ThemeToggle variant="inline" />
      </div>
    </aside>
  );
}
