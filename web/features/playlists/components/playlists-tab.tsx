import { ListMusic, Star } from 'lucide-react';
import Link from 'next/link';
import { Cover } from '@/components/ui/cover';
import { NewPlaylistButton } from '@/features/playlists/components/new-playlist-button';
import { getPlaylists } from '@/lib/data/playlists';
import { getT } from '@/lib/i18n/server';

export async function PlaylistsTab() {
  const [t, playlists] = await Promise.all([getT(), getPlaylists()]);
  return (
    <>
      <div className="mb-4">
        <NewPlaylistButton />
      </div>
      <ul
        data-testid="library-playlists"
        className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      >
        {playlists.map(p => {
          const favorites = p.kind === 'favorites';
          return (
            <li key={p.id}>
              <Link
                href={`/playlist/${p.id}`}
                className="bg-card/50 hover:bg-card dark:bg-card-dark/50 dark:hover:bg-card-dark flex h-full flex-col gap-3 rounded-lg p-3 transition-colors"
              >
                <Cover
                  src={p.cover_url}
                  alt={p.name}
                  size="lg"
                  className="aspect-square !h-auto !w-full shadow-lg"
                  fallback={
                    favorites ? (
                      <Star className="h-10 w-10 text-white/80" />
                    ) : (
                      <ListMusic className="h-10 w-10 text-white/80" />
                    )
                  }
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="line-clamp-2 text-sm font-semibold">
                    {favorites ? t('playlist.favorites') : p.name}
                  </span>
                  <span className="text-muted text-xs">
                    {favorites ? t('playlist.favoritesHint') : t('count.tracks', { count: p.track_count })}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
