import { Search } from 'lucide-react';
import Link from 'next/link';
import { ShortcutHint } from '@/components/shortcut-hint';
import { EmptyState } from '@/components/ui/empty-state';
import { ArtistCard, LibraryAlbumCard } from '@/features/library/components/library-cards';
import { LibraryTrackRow } from '@/features/library/components/library-track-row';
import { getLibraryAlbums, getLibraryArtists, getLibraryTracks } from '@/lib/data/library';
import { getT } from '@/lib/i18n/server';

const RECENT_ALBUMS = 12;
const READY_TRACKS = 10;

export async function HomeContent() {
  const t = await getT();
  const [albums, artists, tracks] = await Promise.all([
    getLibraryAlbums('', undefined, RECENT_ALBUMS),
    getLibraryArtists('', undefined, RECENT_ALBUMS),
    getLibraryTracks('found,ready', undefined, READY_TRACKS),
  ]);

  // Артист, чья дискография ещё импортируется (или пуста), показывается сразу — альбомы появятся по мере импорта.
  const recent = [
    ...albums.items.map(a => ({ album: a, at: a.added_at ?? '', key: `album:${a.id}` })),
    ...artists.items
      .filter(a => a.import != null || a.album_count === 0)
      .map(a => ({ artist: a, at: a.added_at ?? '', key: `artist:${a.id}` })),
  ]
    .sort((x, y) => y.at.localeCompare(x.at))
    .slice(0, RECENT_ALBUMS);

  if (recent.length === 0 && tracks.items.length === 0) {
    return (
      <EmptyState title={t('home.findMusic.title')} body={t('home.findMusic.body')}>
        <Link
          href="/search"
          className="bg-accent hover:bg-accent-hover inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold text-white"
        >
          <Search className="h-4 w-4" aria-hidden />
          {t('library.empty.cta')}
          <ShortcutHint className="rounded border border-white/40 px-1.5 py-0.5 font-mono text-[10px]" />
        </Link>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      {recent.length > 0 ? (
        <section aria-labelledby="home-recent">
          <h2 id="home-recent" className="mb-4">
            {t('home.recent')}
          </h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {recent.map((r, i) => (
              <li key={r.key}>
                {'album' in r ? (
                  <LibraryAlbumCard album={r.album} priority={i < 4} />
                ) : (
                  <ArtistCard artist={r.artist} />
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="home-ready">
        <h2 id="home-ready" className="mb-4">
          {t('home.ready')}
        </h2>
        {tracks.items.length === 0 ? (
          <p className="text-muted text-sm">{t('home.readyEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {tracks.items.map(t => (
              <li key={t.id}>
                <LibraryTrackRow track={t} queue={tracks.items} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
