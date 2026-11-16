import * as Ariakit from '@ariakit/react';
import { ArrowDownToLine, CircleArrowDown, Clock, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { menuItemClass } from '@/components/library/row-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { appData } from '@/lib/app-data';
import { useT } from '@/lib/i18n/provider';
import { offline } from '@/lib/offline';
import { pinSubject, removeSubject } from '@/lib/offline/actions';
import { useOfflineSupported, useTrackOffline } from '@/lib/offline/hooks';
import { albumTrackIds, FAVORITES_PIN_ID, playlistTrackIds } from '@/lib/offline/status';
import { cn } from '@/lib/utils';
import { ProgressRing } from './ring';

/** Маленький индикатор состояния трека в строке: виден, только если трек закреплён или скачан в составе альбома/плейлиста. */
export function TrackOfflineIndicator({ trackId, className }: { trackId: number; className?: string }) {
  const t = useT();
  const supported = useOfflineSupported();
  const state = useTrackOffline(trackId);
  if (!supported || state.kind === 'none' || state.kind === 'partial') return null;
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

/**
 * Одна иконка доступности трека в строке: если трек есть на устройстве (скачан, качается, в очереди, ошибка) —
 * его состояние на устройстве (скачанное на устройство заведомо есть и на сервере); иначе — `fallback`
 * (статус поиска и сервера).
 */
export function TrackAvailability({ trackId, fallback }: { trackId: number; fallback: ReactNode }) {
  const supported = useOfflineSupported();
  const state = useTrackOffline(trackId);
  if (!supported || state.kind === 'none' || state.kind === 'partial') return <>{fallback}</>;
  return <TrackOfflineIndicator trackId={trackId} />;
}

type Cover = { kind: 'album' | 'playlist'; id: number; name: string };

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
 * Пункт меню трека «Скачать на устройство / Удалить с устройства» и диалог к нему. Трек, скачанный в составе
 * закреплённого альбома или плейлиста, одним закреплением не удалить (сверка вернёт файл) — тогда диалог
 * предлагает снять закрепление альбома/плейлиста. `item` кладётся внутрь меню, `dialog` — рядом с ним.
 */
export function useTrackOfflineMenu(track: { id: number; albumId?: number; title: string }): {
  item: ReactNode;
  dialog: ReactNode;
} {
  const t = useT();
  const supported = useOfflineSupported();
  const state = useTrackOffline(track.id);
  const store = Ariakit.useDialogStore();
  const [cover, setCover] = useState<Cover | null>(null);
  if (!supported) return { dialog: null, item: null };

  const subject = { id: track.id, kind: 'track', title: track.title, trackIds: [track.id] } as const;
  const onClick = () => {
    if (state.kind === 'none') return void pinSubject(subject);
    const found = findCover(track.id, track.albumId, t('playlist.favorites'));
    if (!found) return void removeSubject(subject);
    setCover(found);
    store.show();
  };
  return {
    dialog: (
      <ConfirmDialog
        confirmAction={async () => {
          if (cover) {
            await offline().manager?.unpin(cover.kind, cover.id);
            await removeSubject(subject);
          }
          return true;
        }}
        confirmLabel={t(cover?.kind === 'playlist' ? 'offline.cover.confirmPlaylist' : 'offline.cover.confirmAlbum')}
        description={t(cover?.kind === 'playlist' ? 'offline.cover.playlist' : 'offline.cover.album', {
          name: cover?.name ?? '',
          title: track.title,
        })}
        store={store}
        title={t(cover?.kind === 'playlist' ? 'offline.cover.titlePlaylist' : 'offline.cover.titleAlbum')}
        variant="primary"
      />
    ),
    item: (
      <Ariakit.MenuItem className={menuItemClass} data-testid="track-offline-item" onClick={onClick}>
        {state.kind === 'none' ? t('offline.menu.download') : t('offline.remove')}
      </Ariakit.MenuItem>
    ),
  };
}
