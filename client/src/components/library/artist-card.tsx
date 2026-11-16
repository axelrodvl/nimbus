import { Link } from 'react-router';
import { useT } from '@/lib/i18n/provider';
import type { ArtistView } from '@/lib/store/selectors';
import { ArtistAvatar } from './artist-avatar';

/** Высота карточки артиста (не зависит от ширины): аватар 112 + отступы + блок текста. */
export const ARTIST_CARD_HEIGHT = 244;

/** Карточка артиста. Артист без альбомов и треков — дискография ещё импортируется. */
export function ArtistCard({ artist }: { artist: ArtistView }) {
  const t = useT();
  const importing = artist.albumCount === 0 && artist.trackCount === 0;
  return (
    <Link
      className="hover:bg-card dark:hover:bg-card-dark focus-visible:ring-accent/40 flex h-full flex-col items-center gap-3 rounded-lg px-0 py-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
      data-testid="artist-card"
      to={`/artist/${artist.id}`}
    >
      <ArtistAvatar className="h-28 w-28 text-3xl" mbid={artist.mbid} name={artist.name} />
      <div className="flex h-[5.5rem] min-w-0 flex-col items-center overflow-hidden text-center">
        <span className="line-clamp-2 text-sm font-semibold">{artist.name}</span>
        <span className="text-muted line-clamp-2 text-xs">
          {t('count.albums', { count: artist.albumCount })} · {t('count.tracks', { count: artist.trackCount })}
        </span>
        {importing ? (
          <span className="text-muted text-xs italic" data-testid="artist-import-badge">
            {t('artist.badge.importing')}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
