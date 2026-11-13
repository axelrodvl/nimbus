'use client';

import * as Ariakit from '@ariakit/react';
import { ListMusic, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { addTrackToPlaylist, createPlaylist, loadPlaylists } from '@/app/actions/playlists';
import { Cover } from '@/components/ui/cover';
import { Spinner } from '@/components/ui/spinner';
import { NewPlaylistForm } from '@/features/playlists/components/new-playlist-form';
import type { Schemas } from '@/lib/api/client';
import { useT } from '@/providers/i18n-provider';

type Props = { store: Ariakit.DialogStore; trackId: number; title: string };

// Выбор плейлиста для трека. Список приходит с бэкенда уже отсортированным: недавно использованные — первыми.
// Содержимое монтируется заново при каждом открытии (`unmountOnHide`) и всегда грузит свежий порядок.
export function AddToPlaylistDialog(props: Props) {
  const t = useT();
  return (
    <Ariakit.Dialog
      store={props.store}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      backdrop={<div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />}
      className="border-divider dark:border-divider-dark fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border bg-white p-6 shadow-2xl outline-none dark:bg-black"
      unmountOnHide
    >
      <Ariakit.DialogHeading className="text-lg font-bold">{t('playlist.addTo')}</Ariakit.DialogHeading>
      <Ariakit.DialogDescription className="text-muted truncate text-sm">{props.title}</Ariakit.DialogDescription>
      <Body {...props} />
    </Ariakit.Dialog>
  );
}

function Body({ store, trackId }: Props) {
  const t = useT();
  const [playlists, setPlaylists] = useState<Schemas['PlaylistDto'][] | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadPlaylists().then(r => {
      if (cancelled) return;
      if (r.ok) setPlaylists(r.playlists.filter(p => p.kind === 'user'));
      else {
        toast.error(r.message);
        setPlaylists([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function add(playlist: Schemas['PlaylistDto']) {
    setBusy(true);
    const r = await addTrackToPlaylist(playlist.id, trackId);
    setBusy(false);
    if (r.ok) {
      toast.success(t('playlist.addedTo', { name: playlist.name }));
      store.hide();
    } else toast.error(r.message);
  }

  async function createAndAdd(name: string) {
    const created = await createPlaylist(name);
    if (!created.ok) {
      toast.error(created.message);
      return false;
    }
    await add(created.playlist);
    return true;
  }

  if (playlists === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  return (
    <>
      {creating || playlists.length === 0 ? (
        <NewPlaylistForm onSubmit={createAndAdd} onCancel={playlists.length ? () => setCreating(false) : undefined} />
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="hover:bg-card dark:hover:bg-card-dark flex items-center gap-3 rounded-lg px-2 py-2 text-left text-sm font-medium"
        >
          <span className="bg-card dark:bg-card-dark flex h-10 w-10 items-center justify-center rounded-md">
            <Plus className="h-5 w-5" aria-hidden />
          </span>
          {t('playlist.new')}
        </button>
      )}
      {playlists.length === 0 ? <p className="text-muted text-sm">{t('playlist.none')}</p> : null}
      <ul data-testid="playlist-picker" className="-mx-2 flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {playlists.map(p => (
          <li key={p.id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void add(p)}
              className="hover:bg-card dark:hover:bg-card-dark flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left disabled:opacity-60"
            >
              <Cover src={p.cover_url ?? null} alt={p.name} size="sm" fallback={<ListMusic className="h-4 w-4" />} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{p.name}</span>
                <span className="text-muted text-xs">{t('count.tracks', { count: p.track_count })}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
