import * as Ariakit from '@ariakit/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { AddToPlaylistDialog } from '@/components/playlists/add-to-playlist-dialog';
import { TrackSourceDialog } from '@/components/sources/track-source-dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useT } from '@/lib/i18n/provider';
import { offline } from '@/lib/offline';
import { removeSubject } from '@/lib/offline/actions';
import { useTrackView } from '@/lib/store/hooks';

/** Закрепление, которое держит трек на устройстве (альбом или плейлист). */
export type Cover = { kind: 'album' | 'playlist'; id: number; name: string };

/** Кнопка «…», открывшая диалог: после закрытия фокус возвращается на неё (если она ещё в DOM). */
export type Opener = RefObject<HTMLElement | null>;

type Target =
  | { kind: 'playlist'; trackId: number }
  | { kind: 'source'; trackId: number }
  | { kind: 'offline-cover'; trackId: number; title: string; cover: Cover };

type Dialogs = {
  addToPlaylist: (trackId: number, opener?: Opener) => void;
  chooseSource: (trackId: number, opener?: Opener) => void;
  confirmOfflineCover: (args: { trackId: number; title: string; cover: Cover }, opener?: Opener) => void;
};

const Context = createContext<Dialogs | null>(null);

/** Диалоги трека — один набор на приложение, а не по набору на каждую строку списка. */
export function useTrackDialogs(): Dialogs {
  const dialogs = useContext(Context);
  if (!dialogs) throw new Error('useTrackDialogs: TrackDialogsProvider is missing');
  return dialogs;
}

/**
 * Хост диалогов трека («В плейлист», «Источник», подтверждение снятия закрепления). Монтируется один раз в оболочке:
 * диалог не принадлежит строке и переживает её размонтирование (прокрутка виртуального списка, смена фильтра).
 * Название трека и альбом берёт сам по `trackId`; если трек исчез из библиотеки — закрывается.
 */
export function TrackDialogsProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [target, setTarget] = useState<Target | null>(null);
  const playlistStore = Ariakit.useDialogStore();
  const sourceStore = Ariakit.useDialogStore();
  const coverStore = Ariakit.useDialogStore();

  const dialogs = useMemo<Dialogs>(() => {
    const open = (store: Ariakit.DialogStore, next: Target, opener?: Opener) => {
      setTarget(next);
      store.setDisclosureElement(opener?.current?.isConnected ? opener.current : null);
      store.show();
    };
    return {
      addToPlaylist: (trackId, opener) => open(playlistStore, { kind: 'playlist', trackId }, opener),
      chooseSource: (trackId, opener) => open(sourceStore, { kind: 'source', trackId }, opener),
      confirmOfflineCover: (args, opener) => open(coverStore, { kind: 'offline-cover', ...args }, opener),
    };
    // Хранилища Ariakit стабильны; функции хоста не должны менять identity — иначе перерисуются все строки.
  }, [playlistStore, sourceStore, coverStore]);

  const view = useTrackView(target?.trackId ?? -1);
  const gone = target !== null && !view;
  useEffect(() => {
    if (!gone) return;
    playlistStore.hide();
    sourceStore.hide();
    coverStore.hide();
  }, [gone, playlistStore, sourceStore, coverStore]);

  const cover = target?.kind === 'offline-cover' ? target : null;
  const confirm = useCallback(async () => {
    if (cover) {
      await offline().manager?.unpin(cover.cover.kind, cover.cover.id);
      await removeSubject({ id: cover.trackId, kind: 'track', title: cover.title, trackIds: [cover.trackId] });
    }
    return true;
  }, [cover]);

  const title = view?.title ?? '';
  const isPlaylist = cover?.cover.kind === 'playlist';
  return (
    <Context.Provider value={dialogs}>
      {children}
      <AddToPlaylistDialog
        store={playlistStore}
        title={title}
        trackId={target?.kind === 'playlist' ? target.trackId : -1}
      />
      <TrackSourceDialog
        albumId={view?.album_id ?? -1}
        store={sourceStore}
        title={title}
        trackId={target?.kind === 'source' ? target.trackId : -1}
      />
      <ConfirmDialog
        confirmAction={confirm}
        confirmLabel={t(isPlaylist ? 'offline.cover.confirmPlaylist' : 'offline.cover.confirmAlbum')}
        description={t(isPlaylist ? 'offline.cover.playlist' : 'offline.cover.album', {
          name: cover?.cover.name ?? '',
          title: cover?.title ?? '',
        })}
        store={coverStore}
        title={t(isPlaylist ? 'offline.cover.titlePlaylist' : 'offline.cover.titleAlbum')}
        variant="primary"
      />
    </Context.Provider>
  );
}
