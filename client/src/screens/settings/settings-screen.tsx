import {
  ArrowLeft,
  ChevronRight,
  Cpu,
  Database,
  Globe,
  HardDriveDownload,
  Info,
  ListRestart,
  Music,
  Palette,
  Search,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { PageLayout } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/error-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAcquisitionSummary } from '@/lib/acquisition/hooks';
import type { MessageKey } from '@/lib/i18n/messages';
import { useT } from '@/lib/i18n/provider';
import { OfflineNotice } from '@/components/offline-notice';
import { useOnline } from '@/lib/live/hooks';
import { useOfflineSupported } from '@/lib/offline/hooks';
import { useSettings } from '@/lib/settings/hooks';
import type { ServerSettings } from '@/lib/settings/types';
import { cn } from '@/lib/utils';
import { JobsSection } from './jobs-section';
import { AboutSection, AppearanceSection } from './local-sections';
import { OfflineSection } from './offline-section';
import { MusicbrainzSection } from './server/musicbrainz';
import { PerformanceSection } from './server/performance';
import { PlaybackSection } from './server/playback';
import { SearchSection } from './server/search';
import { SourcesSection } from './server/sources';
import { StorageSection } from './server/storage';
import { NotFound } from '../not-found';

type Section = {
  id: string;
  label: MessageKey;
  icon: LucideIcon;
  /** Нужны настройки сервера (недоступны без сети и пока не загрузились). */
  server: boolean;
  render: (settings: ServerSettings, readOnly: boolean) => ReactNode;
  /** Пункт-ссылка на другой экран вместо раздела (`/settings/:id` для него не существует). */
  href?: string;
  /** Раздел нужен только там, где есть офлайн-хранилище (в браузере без OPFS он скрыт). */
  needsOfflineStorage?: boolean;
  /** Метка справа от пункта списка (например, число упавших задач). */
  NavBadge?: ComponentType;
};

/** Число упавших фоновых задач у пункта «Фоновые задачи»; нет упавших — метки нет. */
function FailedJobsBadge() {
  const t = useT();
  const count = useAcquisitionSummary().data?.failed_jobs ?? 0;
  if (count === 0) return null;
  return (
    <Badge data-testid="settings-jobs-count" tone="danger">
      <span className="sr-only">{t('settings.jobsFailed', { count })}</span>
      <span aria-hidden className="tabular-nums">
        {count}
      </span>
    </Badge>
  );
}

/** Разделы настроек в порядке показа. Новый раздел — запись здесь. */
export const SETTINGS_SECTIONS: readonly Section[] = [
  {
    icon: Globe,
    id: 'sources',
    label: 'settings.providers',
    render: (s, ro) => <SourcesSection readOnly={ro} settings={s} />,
    server: true,
  },
  {
    icon: Search,
    id: 'search',
    label: 'settings.search',
    render: (s, ro) => <SearchSection readOnly={ro} settings={s} />,
    server: true,
  },
  {
    icon: Database,
    id: 'musicbrainz',
    label: 'settings.mb',
    render: (s, ro) => <MusicbrainzSection readOnly={ro} settings={s} />,
    server: true,
  },
  {
    icon: Music,
    id: 'playback',
    label: 'settings.playback',
    render: (s, ro) => <PlaybackSection readOnly={ro} settings={s} />,
    server: true,
  },
  {
    icon: SlidersHorizontal,
    id: 'storage',
    label: 'settings.storageServer',
    render: (s, ro) => <StorageSection readOnly={ro} settings={s} />,
    server: true,
  },
  {
    icon: Cpu,
    id: 'performance',
    label: 'settings.perf',
    render: (s, ro) => <PerformanceSection readOnly={ro} settings={s} />,
    server: true,
  },
  {
    NavBadge: FailedJobsBadge,
    icon: ListRestart,
    id: 'jobs',
    label: 'settings.jobs',
    render: () => <JobsSection />,
    server: false,
  },
  {
    icon: HardDriveDownload,
    id: 'offline',
    label: 'settings.offline',
    needsOfflineStorage: true,
    render: () => <OfflineSection />,
    server: false,
  },
  { icon: Palette, id: 'appearance', label: 'settings.appearance', render: () => <AppearanceSection />, server: false },
  { icon: Info, id: 'about', label: 'settings.about', render: () => <AboutSection />, server: false },
];

/** Группы пунктов списка — те же заголовки, что у «Загрузок»: где живут эти настройки. */
const NAV_GROUPS: readonly { id: string; label: MessageKey; ids: readonly string[] }[] = [
  {
    id: 'server',
    ids: ['sources', 'search', 'musicbrainz', 'playback', 'storage', 'performance', 'jobs'],
    label: 'acq.group.server',
  },
  { id: 'device', ids: ['offline', 'appearance', 'about'], label: 'acq.group.device' },
];

function SectionSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3" data-testid="settings-skeleton">
      <Skeleton className="h-8 w-48" />
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton className="h-16 w-full rounded-xl" key={i} />
      ))}
    </div>
  );
}

/**
 * Настройки `/settings/:section?`. Настольный вид — список разделов слева, раздел справа; мобильный — `/settings` это
 * список, `/settings/:section` — раздел с кнопкой «назад». Офлайн серверные разделы доступны только для чтения.
 */
export function SettingsScreen() {
  const t = useT();
  const param = useParams().section;
  const offline = !useOnline();
  const settings = useSettings();
  const storageSupported = useOfflineSupported();
  const sections = SETTINGS_SECTIONS.filter(s => storageSupported || !s.needsOfflineStorage);

  const current = sections.find(s => s.id === param && !s.href);
  if (param && !current) return <NotFound />;
  const active = current ?? sections.find(s => !s.href);
  if (!active) return null;

  let body: ReactNode;
  if (active.server && settings.isPending) body = <SectionSkeleton />;
  else if (active.server && !settings.data)
    body = (
      <ErrorState body={offline ? t('settings.offlineNoData') : undefined} title={t('common.loadFailed')}>
        <Button onClick={() => void settings.refetch()} variant="secondary">
          {t('common.retry')}
        </Button>
      </ErrorState>
    );
  else body = active.render(settings.data ?? {}, offline);

  return (
    <PageLayout title={t('nav.settings')}>
      <OfflineNotice className="mb-4">{t('settings.offlineNote')}</OfflineNotice>
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav
          aria-label={t('settings.nav')}
          className={cn('md:block md:w-64 md:shrink-0', param ? 'hidden' : 'block')}
          data-testid="settings-nav"
        >
          <div className="flex flex-col gap-5">
            {NAV_GROUPS.map(group => {
              const items = sections.filter(s => group.ids.includes(s.id));
              if (items.length === 0) return null;
              return (
                <section aria-labelledby={`settings-group-${group.id}`} key={group.id}>
                  <h2
                    className="text-muted mb-1.5 px-3 text-xs font-semibold tracking-wide uppercase"
                    id={`settings-group-${group.id}`}
                  >
                    {t(group.label)}
                  </h2>
                  <div className="max-md:bg-card max-md:dark:bg-card-dark max-md:rounded-2xl">
                    <ul className="max-md:divide-divider max-md:dark:divide-divider-dark flex flex-col max-md:divide-y md:gap-1">
                      {items.map(s => {
                        const Icon = s.icon;
                        const NavBadge = s.NavBadge;
                        const selected = s.id === active.id;
                        return (
                          <li key={s.id}>
                            <Link
                              aria-current={selected && param ? 'page' : undefined}
                              className={cn(
                                'focus-visible:ring-accent/40 flex min-h-12 items-center gap-4 rounded-xl px-3 py-2.5 text-sm outline-none focus-visible:ring-2 max-md:px-5 md:gap-3 md:py-0',
                                selected
                                  ? 'md:bg-card md:dark:bg-card-dark md:font-semibold'
                                  : 'md:text-muted md:hover:text-black md:dark:hover:text-white',
                              )}
                              data-testid={`settings-link-${s.id}`}
                              to={s.href ?? `/settings/${s.id}`}
                            >
                              <Icon aria-hidden className="text-muted size-5 shrink-0" />
                              <span className="flex-1 max-md:font-medium">{t(s.label)}</span>
                              {NavBadge ? <NavBadge /> : null}
                              <ChevronRight aria-hidden className="text-muted size-4 shrink-0 md:hidden" />
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </section>
              );
            })}
          </div>
        </nav>
        <div className={cn('min-w-0 md:block md:max-w-3xl md:flex-1', param ? 'block' : 'hidden')}>
          <Link
            className="text-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-black md:hidden dark:hover:text-white"
            data-testid="settings-back"
            to="/settings"
          >
            <ArrowLeft aria-hidden className="size-4" />
            {t('common.back')}
          </Link>
          {body}
        </div>
      </div>
    </PageLayout>
  );
}
