import {
  ArrowLeft,
  ChevronRight,
  CirclePlay,
  HardDrive,
  HardDriveDownload,
  Magnet,
  Search,
  Smartphone,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { AlbumTabView } from '@/components/downloads/album-tab';
import { DeviceTab } from '@/components/downloads/device-tab';
import { DownloadAllButton, PauseAllButton, StorageLine } from '@/components/downloads/header-actions';
import { TorrentsTab } from '@/components/downloads/torrents-tab';
import { OfflineNotice } from '@/components/offline-notice';
import { PageLayout } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { useAcquisitionSummary, useEngineTorrents } from '@/lib/acquisition/hooks';
import {
  defaultTab,
  downloadGroups,
  isAlbumTab,
  isDownloadTab,
  tabCount,
  type DownloadTab,
} from '@/lib/acquisition/model';
import { useT } from '@/lib/i18n/provider';
import { useOnline } from '@/lib/live/hooks';
import { useOfflineStatus, useOfflineSupported, usePendingCount } from '@/lib/offline/hooks';
import { useStorage } from '@/lib/settings/hooks';
import { formatSize } from '@/lib/sources/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '../settings/section-frame';
import { NotFound } from '../not-found';

const ICONS: Record<DownloadTab, LucideIcon> = {
  attention: TriangleAlert,
  available: CirclePlay,
  device: Smartphone,
  downloaded: HardDrive,
  downloading: HardDriveDownload,
  searching: Search,
  torrents: Magnet,
};

/** Заполненность хранилища: полоса и «занято X из Y · свободно Z». Цвет — предупреждение от 90 %, ошибка при переполнении. */
function SpaceMeter({ id, used, limit, label }: { id: string; used: number; limit: number; label: string }) {
  const t = useT();
  const ratio = used / limit;
  const free = Math.max(0, limit - used);
  return (
    <div
      className="border-divider dark:border-divider-dark flex flex-col gap-2 px-3 py-3 max-md:border-b"
      data-testid={`acq-space-${id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="text-muted whitespace-nowrap">
          {t('acq.space.used', { limit: formatSize(limit, t), used: formatSize(used, t) })}
        </span>
        <span className={cn('font-medium whitespace-nowrap tabular-nums', ratio >= 1 && 'text-danger-fg')}>
          {t('acq.space.free', { free: formatSize(free, t) })}
        </span>
      </div>
      <ProgressBar
        aria-label={label}
        className="h-1.5"
        max={limit}
        tone={ratio >= 1 ? 'danger' : ratio >= 0.9 ? 'warning' : 'accent'}
        value={used}
      />
    </div>
  );
}

/** Место на диске сервера (настройки хранилища); пока не загрузилось или без связи — ничего. */
function ServerSpace() {
  const t = useT();
  const { data } = useStorage();
  if (!data || data.limit_bytes <= 0) return null;
  return <SpaceMeter id="server" label={t('acq.space.serverLabel')} limit={data.limit_bytes} used={data.used_bytes} />;
}

/** Место под офлайн-музыку на этом устройстве (лимит с учётом квоты браузера). */
function DeviceSpace() {
  const t = useT();
  const { bytes, limit } = useOfflineStatus(s => s.usage);
  if (limit <= 0) return null;
  return <SpaceMeter id="device" label={t('acq.space.deviceLabel')} limit={limit} used={bytes} />;
}

/** Действия, относящиеся к разделу целиком: показываются над его списком. */
function SectionActions({ tab }: { tab: DownloadTab }) {
  let actions: ReactNode = null;
  if (tab === 'available') actions = <DownloadAllButton />;
  else if (tab === 'downloading' || tab === 'torrents') actions = <PauseAllButton />;
  else if (tab === 'downloaded') actions = <StorageLine />;
  if (!actions) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="acq-actions">
      {actions}
    </div>
  );
}

function SectionBody({ tab }: { tab: DownloadTab }) {
  if (isAlbumTab(tab)) return <AlbumTabView key={tab} tab={tab} />;
  if (tab === 'torrents') return <TorrentsTab />;
  return <DeviceTab />;
}

/** Счётчики пунктов списка: альбомы — из сводки, торренты — из движка, устройство — очередь загрузок. */
function useCounts(): { count: (tab: DownloadTab) => number | undefined; paused: boolean } {
  const summary = useAcquisitionSummary();
  const engine = useEngineTorrents(false);
  const pending = usePendingCount();
  const torrents = engine.data?.torrents.length ?? 0;
  return {
    count: tab => {
      if (tab === 'device') return pending > 0 ? pending : undefined;
      if (tab === 'torrents') return torrents > 0 ? torrents : undefined;
      return tabCount(tab, summary.data);
    },
    paused: engine.data?.paused ?? false,
  };
}

/**
 * «Загрузки» `/downloads/:tab?` — устроены как настройки: список разделов, сгруппированных по тому, где музыка
 * (поиск источников, диск сервера с его торрентами, это устройство), и выбранный раздел. На широком экране список
 * слева, раздел справа; на узком `/downloads` — список, `/downloads/:tab` — раздел с кнопкой «назад».
 * Без раздела в адресе на широком экране открывается первый непустой («Требуют внимания», если не пуст),
 * без связи — «На этом устройстве». Фоновые задачи сервера живут в настройках (`/settings/jobs`).
 */
export function DownloadsScreen() {
  const t = useT();
  const param = useParams().tab;
  const summary = useAcquisitionSummary();
  const supported = useOfflineSupported();
  const online = useOnline();
  const { count, paused } = useCounts();
  const groups = downloadGroups(supported);
  // Бывшая вкладка «Задачи» переехала в настройки.
  if (param === 'jobs') return <Navigate replace to="/settings/jobs" />;
  if (param && (!isDownloadTab(param) || !groups.some(g => g.tabs.includes(param)))) return <NotFound />;
  const active: DownloadTab =
    param && isDownloadTab(param) ? param : !online && supported ? 'device' : defaultTab(summary.data);

  return (
    <PageLayout title={t('nav.downloads')}>
      {active === 'device' ? null : <OfflineNotice className="mb-4">{t('acq.offline')}</OfflineNotice>}
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav
          aria-label={t('acq.tabs')}
          className={cn('flex-col gap-5 md:flex md:w-64 md:shrink-0', param ? 'hidden' : 'flex')}
          data-testid="acq-nav"
        >
          {groups.map(group => (
            <section aria-labelledby={`acq-group-${group.id}`} data-testid={`acq-group-${group.id}`} key={group.id}>
              <h2
                className="text-muted mb-1.5 px-3 text-xs font-semibold tracking-wide uppercase"
                id={`acq-group-${group.id}`}
              >
                {t(`acq.group.${group.id}`)}
              </h2>
              <div className="max-md:bg-card max-md:dark:bg-card-dark max-md:rounded-2xl">
                {group.id === 'server' ? <ServerSpace /> : group.id === 'device' ? <DeviceSpace /> : null}
                <ul className="max-md:divide-divider max-md:dark:divide-divider-dark flex flex-col max-md:divide-y md:gap-1">
                  {group.tabs.map(id => {
                    const Icon = ICONS[id];
                    const n = count(id);
                    const selected = id === active;
                    return (
                      <li key={id}>
                        <Link
                          aria-current={selected && param ? 'page' : undefined}
                          className={cn(
                            'focus-visible:ring-accent/40 flex min-h-12 items-center gap-4 rounded-xl px-3 py-2.5 text-sm outline-none focus-visible:ring-2 max-md:px-5 md:gap-3 md:py-0',
                            selected
                              ? 'md:bg-card md:dark:bg-card-dark md:font-semibold'
                              : 'md:text-muted md:hover:text-black md:dark:hover:text-white',
                          )}
                          data-testid={`acq-tab-link-${id}`}
                          to={`/downloads/${id}`}
                        >
                          <Icon
                            aria-hidden
                            className={cn(
                              'size-5 shrink-0',
                              id === 'attention' && n ? 'text-warning-fg' : 'text-muted',
                            )}
                          />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="max-md:font-medium">{t(`acq.tab.${id}`)}</span>
                            <span className="text-muted text-xs md:hidden">{t(`acq.desc.${id}`)}</span>
                          </span>
                          {id === 'downloading' && paused ? <Badge tone="warning">{t('acq.paused')}</Badge> : null}
                          {n === undefined ? null : id === 'attention' && n > 0 ? (
                            <Badge tone="warning">
                              <span className="tabular-nums">{n}</span>
                            </Badge>
                          ) : (
                            <span className="text-muted text-sm tabular-nums">{n}</span>
                          )}
                          <ChevronRight aria-hidden className="text-muted size-4 shrink-0 md:hidden" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          ))}
        </nav>
        <div
          className={cn('min-w-0 flex-col gap-4 md:flex md:flex-1', param ? 'flex' : 'hidden')}
          data-testid="acq-section"
        >
          <Link
            className="text-muted inline-flex items-center gap-1 self-start text-sm hover:text-black md:hidden dark:hover:text-white"
            data-testid="acq-back"
            to="/downloads"
          >
            <ArrowLeft aria-hidden className="size-4" />
            {t('common.back')}
          </Link>
          <PageHeader description={t(`acq.desc.${active}`)} title={t(`acq.tab.${active}`)} />
          <SectionActions tab={active} />
          <SectionBody tab={active} />
        </div>
      </div>
    </PageLayout>
  );
}

/** Старый адрес `/settings/downloads` ведёт на раздел торрентов. */
export const LegacyDownloadsRedirect = () => <Navigate replace to="/downloads/torrents" />;
