import { Navigate, useParams } from 'react-router';
import { AlbumTabView } from '@/components/downloads/album-tab';
import { DeviceTab } from '@/components/downloads/device-tab';
import { DownloadAllButton, PauseAllButton, StorageLine } from '@/components/downloads/header-actions';
import { JobsTab } from '@/components/downloads/jobs-tab';
import { TorrentsTab } from '@/components/downloads/torrents-tab';
import { PageLayout } from '@/components/page-layout';
import { Tabs } from '@/components/ui/tabs';
import { useAcquisitionSummary } from '@/lib/acquisition/hooks';
import { defaultTab, downloadTabs, isAlbumTab, isDownloadTab, tabCount } from '@/lib/acquisition/model';
import { useT } from '@/lib/i18n/provider';
import { useOnline } from '@/lib/live/hooks';
import { useOfflineSupported, usePendingCount } from '@/lib/offline/hooks';
import { NotFound } from '../not-found';

/**
 * «Загрузки» `/downloads/:tab?`: что с библиотекой — ищется, не нашлось, найдено, качается, скачано на сервер;
 * торренты движка и упавшие задачи. Без вкладки в адресе открывается первая непустая («Требуют внимания», если не пуста).
 */
export function DownloadsScreen() {
  const t = useT();
  const param = useParams().tab;
  const summary = useAcquisitionSummary();
  const supported = useOfflineSupported();
  const online = useOnline();
  const pending = usePendingCount();
  const tabs = downloadTabs(supported, !online);
  if (param && (!isDownloadTab(param) || !tabs.includes(param))) return <NotFound />;
  // Пока сводка не пришла, вкладка по умолчанию неизвестна — показываем «Требуют внимания» без редиректа.
  // Без связи серверные вкладки пусты, поэтому открывается «На устройстве».
  const tab = param && isDownloadTab(param) ? param : !online && supported ? 'device' : defaultTab(summary.data);
  return (
    <PageLayout title={t('nav.downloads')}>
      {tab === 'device' ? null : (
        <div className="mb-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <PauseAllButton />
            <DownloadAllButton />
          </div>
          <StorageLine />
        </div>
      )}
      <div className="mb-4 overflow-x-auto pb-1" data-testid="acq-tabs-scroll">
        <Tabs
          aria-label={t('acq.tabs')}
          className="w-max flex-nowrap"
          items={tabs.map(id => {
            const count = id === 'device' ? (pending > 0 ? pending : undefined) : tabCount(id, summary.data);
            return {
              'data-testid': `acq-tab-link-${id}`,
              id,
              label: (
                <>
                  {t(`acq.tab.${id}`)}
                  {count === undefined ? null : <span className="tabular-nums opacity-70"> {count}</span>}
                </>
              ),
              to: `/downloads/${id}`,
            };
          })}
          selectedId={tab}
        />
      </div>
      {isAlbumTab(tab) ? (
        <AlbumTabView key={tab} tab={tab} />
      ) : tab === 'torrents' ? (
        <TorrentsTab />
      ) : tab === 'device' ? (
        <DeviceTab />
      ) : (
        <JobsTab />
      )}
    </PageLayout>
  );
}

/** Старый адрес `/settings/downloads` ведёт на вкладку торрентов. */
export const LegacyDownloadsRedirect = () => <Navigate replace to="/downloads/torrents" />;
