import * as Ariakit from '@ariakit/react';
import { Disc3, ListMusic, Music2, Pause, Play, RotateCcw, Trash2, Heart } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { OfflineProgressText } from '@/components/offline/device-bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { VirtualList } from '@/components/ui/virtual-list';
import { useStore } from 'zustand';
import { appData } from '@/lib/app-data';
import { useT } from '@/lib/i18n/provider';
import { removeSubject, retryAllFailed, setOfflinePaused } from '@/lib/offline/actions';
import { doneCount, queueStatus, sortPins, type PinSort, type PinSummary } from '@/lib/offline/derive';
import { useOfflineStatus, usePinSummaries } from '@/lib/offline/hooks';
import { formatSize } from '@/lib/sources/format';
import { cn } from '@/lib/utils';

export const DEVICE_ROW_HEIGHT = 68;

const KIND_ICON = { album: Disc3, playlist: ListMusic, track: Music2 } as const;

function pinHref(p: PinSummary, albumOfTrack: number | undefined): string | null {
  if (p.missing) return null;
  if (p.kind === 'album') return `/album/${p.id}`;
  if (p.kind === 'playlist') return `/playlist/${p.favorites ? 'favorites' : p.id}`;
  return albumOfTrack === undefined ? null : `/album/${albumOfTrack}`;
}

function PinRow({ pin }: { pin: PinSummary }) {
  const t = useT();
  const confirm = Ariakit.useDialogStore();
  const albumOfTrack = useStore(appData().library, s =>
    pin.kind === 'track' ? s.tracks.get(pin.id)?.album_id : undefined,
  );
  const Icon = pin.favorites ? Heart : KIND_ICON[pin.kind];
  const name = pin.favorites ? t('playlist.favorites') : (pin.title ?? t('offline.device.missing'));
  const href = pinHref(pin, albumOfTrack);
  const label = (
    <span className="truncate text-sm font-medium" data-testid="pin-title">
      {name}
    </span>
  );
  return (
    <div
      className="hover:bg-card/60 dark:hover:bg-card-dark/60 flex h-[4.25rem] items-center gap-3 rounded-md px-3"
      data-pin={pin.key}
      data-testid="device-pin"
    >
      <span className="bg-card dark:bg-card-dark flex size-10 shrink-0 items-center justify-center rounded-md">
        <Icon aria-hidden className="text-gray size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {href ? (
          <Link className="min-w-0 truncate hover:underline" to={href}>
            {label}
          </Link>
        ) : (
          label
        )}
        <OfflineProgressText pin={pin} />
        {pin.state.kind === 'downloading' ? (
          <ProgressBar
            aria-label={t('offline.state.downloading', { percent: Math.round(pin.state.progress * 100), title: name })}
            className="h-1"
            max={1}
            value={pin.state.progress}
          />
        ) : null}
      </div>
      <Button
        aria-label={t('offline.device.removeNamed', { title: name })}
        data-testid="pin-remove"
        onClick={confirm.show}
        size="icon"
        title={t('offline.remove')}
        variant="ghost"
      >
        <Trash2 aria-hidden className="size-4" />
      </Button>
      <ConfirmDialog
        confirmAction={async () => {
          await removeSubject({ id: pin.id, kind: pin.kind, title: name, trackIds: pin.trackIds });
          return true;
        }}
        confirmLabel={t('offline.remove')}
        description={t('offline.device.removeConfirm', { title: name })}
        store={confirm}
        title={t('offline.remove')}
      />
    </div>
  );
}

function ActiveDownloads() {
  const t = useT();
  const files = useOfflineStatus(s => s.files);
  const tracks = useStore(appData().library, s => s.tracks);
  const active = [...files].filter(([, f]) => f.state === 'downloading');
  if (active.length === 0) return null;
  return (
    <section aria-label={t('offline.device.active')} className="flex flex-col gap-2" data-testid="device-active">
      <h3 className="text-sm">{t('offline.device.active')}</h3>
      <ul className="flex flex-col gap-2">
        {active.map(([id, f]) => {
          const progress = f.bytesTotal ? Math.min(1, f.bytesDone / f.bytesTotal) : 0;
          const title = tracks.get(id)?.title ?? t('offline.device.missing');
          return (
            <li className="flex items-center gap-3" data-testid="device-active-row" key={id}>
              <span className="w-40 min-w-0 shrink-0 truncate text-sm sm:w-64">{title}</span>
              <ProgressBar
                aria-label={t('offline.state.downloading', { percent: Math.round(progress * 100), title })}
                className="flex-1"
                max={1}
                value={progress}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Вкладка «На устройстве»: занятое место, состояние очереди, активные загрузки и закрепления. */
export function DeviceTab() {
  const t = useT();
  const status = useOfflineStatus(s => s);
  const pins = usePinSummaries();
  const [sort, setSort] = useState<PinSort>('date');
  const q = queueStatus(status);
  const { bytes, limit, quota } = status.usage;
  const ratio = limit > 0 ? bytes / limit : 0;
  const sorted = sortPins(pins, sort);
  const queueText = t(`offline.queue.${q.key}`, { active: q.active, count: q.failed, queued: q.queued });

  return (
    <div className="flex flex-col gap-5" data-testid="device-tab">
      <section
        aria-label={t('offline.device.summary')}
        className="bg-card dark:bg-card-dark flex flex-col gap-3 rounded-2xl p-4"
      >
        <ProgressBar
          aria-label={t('offline.device.usageLabel')}
          max={limit > 0 ? limit : 1}
          tone={ratio >= 1 ? 'danger' : ratio >= 0.9 ? 'warning' : 'accent'}
          value={bytes}
        />
        <p className="text-sm" data-testid="device-usage">
          {t('offline.device.usage', { limit: formatSize(limit, t), used: formatSize(bytes, t) })}
          {quota ? ` · ${t('offline.device.quota', { quota: formatSize(quota, t) })}` : ''}
          {` · ${t('count.tracks', { count: doneCount(status) })}`}
        </p>
        <p
          className={cn('text-sm', q.key === 'quota' || q.key === 'failed' ? 'text-danger-fg' : 'text-muted')}
          data-testid="device-queue"
          data-queue={q.key}
          role="status"
        >
          {queueText}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button data-testid="device-pause" onClick={() => setOfflinePaused(!status.paused)} variant="secondary">
            {status.paused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}
            {status.paused ? t('offline.device.resume') : t('offline.device.pause')}
          </Button>
          <Button data-testid="device-retry" disabled={q.failed === 0} onClick={retryAllFailed} variant="secondary">
            <RotateCcw aria-hidden className="size-4" />
            {t('offline.device.retryFailed')}
          </Button>
        </div>
      </section>
      <ActiveDownloads />
      {pins.length === 0 ? (
        <EmptyState body={t('offline.device.emptyHint')} title={t('offline.device.empty')} />
      ) : (
        <section aria-label={t('offline.device.pins')} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm">{t('offline.device.pins')}</h3>
            <SegmentedControl<PinSort>
              aria-label={t('offline.device.sort')}
              onValueChange={setSort}
              options={[
                { label: t('offline.device.sortDate'), value: 'date' },
                { label: t('offline.device.sortSize'), value: 'size' },
              ]}
              value={sort}
            />
          </div>
          <VirtualList
            aria-label={t('offline.device.pins')}
            count={sorted.length}
            data-testid="device-pins"
            getKey={i => sorted[i]?.key ?? i}
            renderRow={i => (sorted[i] ? <PinRow pin={sorted[i]} /> : null)}
            rowHeight={DEVICE_ROW_HEIGHT}
          />
        </section>
      )}
    </div>
  );
}
