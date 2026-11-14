import type * as Ariakit from '@ariakit/react';
import { Check, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog } from '@/components/ui/dialog';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { addTrackToPlaylist, createPlaylist } from '@/lib/playlists/actions';
import { usePlaylistCards, usePlaylistsOfTrack } from '@/lib/store/hooks';
import { NewPlaylistForm } from './new-playlist-form';
import { PlaylistCover } from './playlist-cover';

type Props = { store: Ariakit.DialogStore; trackId: number; title: string };

/**
 * «Добавить в плейлист»: пользовательские плейлисты по недавности добавления (список уже отсортирован селектором),
 * отметка «уже добавлен», создание нового прямо в окне (трек сразу попадает в него).
 */
export function AddToPlaylistDialog({ store, trackId, title }: Props) {
  const t = useT();
  return (
    <Dialog description={title} store={store} title={t('playlist.addTo')}>
      <Body store={store} title={title} trackId={trackId} />
    </Dialog>
  );
}

function Body({ store, trackId }: Props) {
  const t = useT();
  const playlists = usePlaylistCards().filter(p => p.kind === 'user');
  const memberOf = usePlaylistsOfTrack(trackId);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  async function add(id: number, name: string): Promise<boolean> {
    setBusy(true);
    try {
      const result = await addTrackToPlaylist(id, trackId);
      toast.success(t(result === 'exists' ? 'playlist.alreadyIn' : 'playlist.addedTo', { name }));
      store.hide();
      return true;
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createAndAdd(name: string) {
    let id: number;
    try {
      id = await createPlaylist(name);
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
      return false;
    }
    return add(id, name);
  }

  const showForm = creating || playlists.length === 0;
  return (
    <>
      {showForm ? (
        <NewPlaylistForm onCancel={playlists.length ? () => setCreating(false) : undefined} onSubmit={createAndAdd} />
      ) : (
        <button
          className="hover:bg-card dark:hover:bg-card-dark focus-visible:ring-accent/40 flex items-center gap-3 rounded-lg px-2 py-2 text-left text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
          data-testid="picker-new-playlist"
          onClick={() => setCreating(true)}
          type="button"
        >
          <span className="bg-card dark:bg-card-dark flex size-10 items-center justify-center rounded-md">
            <Plus aria-hidden className="size-5" />
          </span>
          {t('playlist.new')}
        </button>
      )}
      {playlists.length === 0 ? <p className="text-muted text-sm">{t('playlist.none')}</p> : null}
      <ul className="-mx-2 flex min-h-0 flex-col gap-0.5 overflow-y-auto" data-testid="playlist-picker">
        {playlists.map(p => {
          const inside = typeof p.id === 'number' && memberOf.has(p.id);
          return (
            <li key={p.id}>
              <button
                className="hover:bg-card dark:hover:bg-card-dark focus-visible:ring-accent/40 flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
                data-in-playlist={inside || undefined}
                disabled={busy}
                onClick={() => typeof p.id === 'number' && void add(p.id, p.name)}
                type="button"
              >
                <PlaylistCover alt={p.name} card={p} className="size-10" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  <span className="text-muted text-xs">{t('count.tracks', { count: p.trackCount })}</span>
                </span>
                {inside ? (
                  <span className="text-accent flex items-center gap-1 text-xs" data-testid="already-added">
                    <Check aria-hidden className="size-4" />
                    {t('playlist.inPlaylist')}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
