import { Link } from 'react-router';
import { EmptyState } from '@/components/ui/empty-state';
import { useDeferredValue } from 'react';
import { useT } from '@/lib/i18n/provider';
import { PlayTracksButton } from '@/components/player/play-buttons';
import { useFavorites, usePlaylistCards, usePlaylistTracks } from '@/lib/store/hooks';
import { filterByName, type PlaylistCard } from '@/lib/store/selectors';
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
          {cards.map(card => (
            <li key={card.id}>
              <PlaylistCardLink card={card} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Круглая кнопка «Слушать» на карточке плейлиста: очередь — доступные треки плейлиста по порядку. */
function PlayPlaylistButton({ id, name }: { id: PlaylistCard['id']; name: string }) {
  const favorites = useFavorites();
  const entries = usePlaylistTracks(typeof id === 'number' ? id : -1);
  const tracks = id === 'favorites' ? favorites : entries.map(e => e.track);
  return <PlayTracksButton label={name} testId="play-playlist-card" tracks={tracks} variant="icon" />;
}

/** Карточка плейлиста: как карточка альбома — обложка с кнопкой воспроизведения, название и число треков. */
export function PlaylistCardLink({ card }: { card: PlaylistCard }) {
  const t = useT();
  const name = card.kind === 'favorites' ? t('playlist.favorites') : card.name;
  return (
    <div className="group/card relative h-full">
      <Link
        className="hover:bg-card dark:hover:bg-card-dark focus-visible:ring-accent/40 flex h-full flex-col gap-3 rounded-lg px-0 py-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
        data-playlist-id={card.id}
        data-testid="playlist-card"
        to={`/playlist/${card.id}`}
      >
        <PlaylistCover alt={name} card={card} className="aspect-square w-full shadow-lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
          <span className="line-clamp-2 text-sm font-semibold">{name}</span>
          <span className="text-muted line-clamp-2 text-xs">
            {card.kind === 'favorites' ? t('playlist.favoritesHint') : t('count.tracks', { count: card.trackCount })}
          </span>
        </div>
      </Link>
      <div className="pointer-events-none absolute inset-x-0 top-3 aspect-square">
        <div className="pointer-events-auto absolute right-2 bottom-2 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100">
          <PlayPlaylistButton id={card.id} name={name} />
        </div>
      </div>
    </div>
  );
}
