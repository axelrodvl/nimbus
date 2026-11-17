import * as Ariakit from '@ariakit/react';
import { ArrowDownToLine, CircleArrowDown, Clock, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { menuItemClass } from '@/components/library/row-menu';
import { useTrackDialogs, type Cover, type Opener } from '@/components/library/track-dialogs';
import { appData } from '@/lib/app-data';
import { useT } from '@/lib/i18n/provider';
import { offline } from '@/lib/offline';
import { pinSubject, removeSubject } from '@/lib/offline/actions';
import { useOfflineSupported, useTrackOffline } from '@/lib/offline/hooks';
import type { OfflineItemState } from '@/lib/offline/status';
import { albumTrackIds, FAVORITES_PIN_ID, playlistTrackIds } from '@/lib/offline/status';
import { cn } from '@/lib/utils';
import { ProgressRing } from './ring';

/** Иконка состояния трека на устройстве (без подписки): `none` и `partial` не рисуются. */
export function TrackOfflineIcon({ state, className }: { state: OfflineItemState; className?: string }) {
  const t = useT();
  if (state.kind === 'none' || state.kind === 'partial') return null;
  const cls = cn('inline-flex size-5 shrink-0 items-center justify-center', className);
  const common = { 'data-state': state.kind, 'data-testid': 'track-offline', role: 'img' } as const;
  if (state.kind === 'done') {
    return (
      <span
        {...common}
        aria-label={t('offline.indicator.done')}
        className={cn(cls, 'text-accent-fg')}
        title={t('offline.indicator.done')}
      >
        <CircleArrowDown aria-hidden className="size-4" strokeWidth={2.5} />
      </span>
    );
  }
  if (state.kind === 'downloading') {
    return (
      <span
        {...common}
        aria-label={t('offline.indicator.downloading', { percent: Math.round(state.progress * 100) })}
        className={cls}
      >
        <ProgressRing progress={state.progress} size={16}>
          <ArrowDownToLine aria-hidden className="text-accent-fg size-2.5" />
        </ProgressRing>
      </span>
    );
  }
  if (state.kind === 'queued') {
    return (
      <span {...common} aria-label={t('offline.indicator.queued')} className={cn(cls, 'text-muted')}>
        <Clock aria-hidden className="size-4" />
      </span>
    );
  }
  return (
    <span {...common} aria-label={t('offline.indicator.failed')} className={cn(cls, 'text-danger-fg')}>
      <TriangleAlert aria-hidden className="size-4" />
    </span>
  );
}

/** Индикатор состояния трека: виден, только если трек закреплён или скачан в составе альбома/плейлиста. */
export function TrackOfflineIndicator({ trackId, className }: { trackId: number; className?: string }) {
  const supported = useOfflineSupported();
  const state = useTrackOffline(trackId);
  return supported ? <TrackOfflineIcon className={className} state={state} /> : null;
}

/**
 * Одна иконка доступности трека в строке: если трек есть на устройстве (скачан, качается, в очереди, ошибка) —
 * его состояние на устройстве (скачанное на устройство заведомо есть и на сервере); иначе — `fallback`
 * (статус поиска и сервера).
 */
export function TrackAvailability({ trackId, fallback }: { trackId: number; fallback: ReactNode }) {
  const supported = useOfflineSupported();
  const state = useTrackOffline(trackId);
  if (!supported || state.kind === 'none' || state.kind === 'partial') return <>{fallback}</>;
  return <TrackOfflineIcon state={state} />;
}

/** Какое закрепление держит этот трек на устройстве (альбом, затем плейлист); `null` — только сам трек. */
function findCover(trackId: number, albumId: number | undefined, favoritesName: string): Cover | null {
  const { pins } = offline().status.getState();
  const lib = appData().library.getState();
  if (albumId !== undefined && pins.has(`album:${albumId}`) && albumTrackIds(lib, albumId).includes(trackId)) {
    return { id: albumId, kind: 'album', name: lib.albums.get(albumId)?.title ?? '' };
  }
  for (const key of pins) {
    if (!key.startsWith('playlist:')) continue;
    const id = Number(key.slice('playlist:'.length));
    if (id === FAVORITES_PIN_ID) {
      if (
        appData()
          .selectors.favorites(lib)
          .some(t => t.id === trackId)
      )
        return { id, kind: 'playlist', name: favoritesName };
    } else if (playlistTrackIds(lib, id).includes(trackId)) {
      return { id, kind: 'playlist', name: lib.playlists.get(id)?.name ?? '' };
    }
  }
  return null;
}

/**
 * Пункт меню трека «Скачать на устройство / Удалить с устройства». Трек, скачанный в составе закреплённого альбома
 * или плейлиста, одним закреплением не удалить (сверка вернёт файл) — тогда общий хост диалогов предлагает снять
 * закрепление альбома/плейлиста. `item` кладётся внутрь меню; `opener` — кнопка «…», на которую вернётся фокус.
 */
export function useTrackOfflineMenu(
  track: { id: number; albumId?: number; title: string },
  opener?: Opener,
): { item: ReactNode } {
  const t = useT();
  const supported = useOfflineSupported();
  const state = useTrackOffline(track.id);
  const dialogs = useTrackDialogs();
  if (!supported) return { item: null };

  const subject = { id: track.id, kind: 'track', title: track.title, trackIds: [track.id] } as const;
  const onClick = () => {
    if (state.kind === 'none') return void pinSubject(subject);
    const found = findCover(track.id, track.albumId, t('playlist.favorites'));
    if (!found) return void removeSubject(subject);
    dialogs.confirmOfflineCover({ cover: found, title: track.title, trackId: track.id }, opener);
  };
  return {
    item: (
      <Ariakit.MenuItem className={menuItemClass} data-testid="track-offline-item" onClick={onClick}>
        {state.kind === 'none' ? t('offline.menu.download') : t('offline.remove')}
      </Ariakit.MenuItem>
    ),
  };
}
