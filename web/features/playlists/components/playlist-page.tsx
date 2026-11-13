import { ListMusic, Star } from 'lucide-react';
import { Cover } from '@/components/ui/cover';
import { EmptyState } from '@/components/ui/empty-state';
import { LibraryTrackRow } from '@/features/library/components/library-track-row';
import { PlayAlbumButton } from '@/features/library/components/play-album-button';
import { DeletePlaylistButton } from '@/features/playlists/components/delete-playlist-button';
import { getPlaylist } from '@/lib/data/playlists';
import { getT } from '@/lib/i18n/server';

export async function PlaylistPage({ id }: { id: string }) {
  const t = await getT();
  const { playlist, tracks } = await getPlaylist(id);
  const favorites = playlist.kind === 'favorites';
  const name = favorites ? t('playlist.favorites') : playlist.name;
  return (
    <>
      <header className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <Cover
          src={playlist.cover_url}
          alt={name}
          size="lg"
          priority
          className="!h-48 !w-48 shrink-0 self-center shadow-2xl sm:self-auto"
          fallback={
            favorites ? <Star className="h-16 w-16 text-white/80" /> : <ListMusic className="h-16 w-16 text-white/80" />
          }
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <span className="text-muted text-xs font-medium tracking-wide uppercase">{t('meta.playlist')}</span>
          <h1 className="text-4xl font-bold tracking-tight">{name}</h1>
          <p className="text-muted text-sm">
            {favorites ? `${t('playlist.favoritesHint')} · ` : ''}
            {t('count.tracks', { count: tracks.length })}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <PlayAlbumButton tracks={tracks} label={t('play.playlist')} />
            {favorites ? null : <DeletePlaylistButton id={playlist.id} name={playlist.name} />}
          </div>
        </div>
      </header>
      {tracks.length === 0 ? (
        <EmptyState title={favorites ? t('playlist.favoritesEmpty') : t('playlist.empty')} />
      ) : (
        <ol data-testid="playlist-tracks" className="flex flex-col gap-0.5">
          {tracks.map(tr => (
            <li key={tr.id}>
              <LibraryTrackRow track={tr} queue={tracks} playlistId={favorites ? undefined : playlist.id} />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
