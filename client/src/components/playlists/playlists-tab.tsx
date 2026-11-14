import { Link } from 'react-router';
import { EmptyState } from '@/components/ui/empty-state';
import { useDeferredValue } from 'react';
import { useT } from '@/lib/i18n/provider';
import { usePlaylistCards } from '@/lib/store/hooks';
import { filterByName } from '@/lib/store/selectors';
import { NewPlaylistButton } from './new-playlist-button';
import { PlaylistCover } from './playlist-cover';

/** Вкладка «Плейлисты»: «Избранное» первым (если есть прослушивания), затем по давности последнего добавления. */
export function PlaylistsTab({ q = '' }: { q?: string }) {
  const t = useT();
  const all = usePlaylistCards();
  const cards = filterByName(all, useDeferredValue(q), c =>
    c.kind === 'favorites' ? t('playlist.favorites') : c.name,
  );
  return (
    <>
      <div className="mb-4">
        <NewPlaylistButton />
      </div>
      {cards.length === 0 ? (
        <EmptyState title={all.length > 0 ? t('search.none') : t('playlist.none')} />
      ) : (
        <ul
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          data-testid="library-playlists"
        >
          {cards.map(card => {
            const name = card.kind === 'favorites' ? t('playlist.favorites') : card.name;
            return (
              <li key={card.id}>
                <Link
                  className="bg-card/50 hover:bg-card dark:bg-card-dark/50 dark:hover:bg-card-dark focus-visible:ring-accent/40 flex h-full flex-col gap-3 rounded-lg p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                  data-playlist-id={card.id}
                  data-testid="playlist-card"
                  to={`/playlist/${card.id}`}
                >
                  <PlaylistCover alt={name} card={card} className="aspect-square w-full shadow-lg" />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="line-clamp-2 text-sm font-semibold">{name}</span>
                    <span className="text-muted text-xs">
                      {card.kind === 'favorites'
                        ? t('playlist.favoritesHint')
                        : t('count.tracks', { count: card.trackCount })}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
