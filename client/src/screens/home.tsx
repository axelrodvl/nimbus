import { Search } from 'lucide-react';
import { Link } from 'react-router';
import { AlbumCard } from '@/components/library/album-card';
import { ArtistCard } from '@/components/library/artist-card';
import { PageLayout } from '@/components/page-layout';
import { PlayAlbumButton, PlayableTrackRow, PlayTracksButton } from '@/components/player/play-buttons';
import { EmptyState } from '@/components/ui/empty-state';
import { useT } from '@/lib/i18n/provider';
import { useOnline } from '@/lib/live/hooks';
import { useCanPlay } from '@/lib/player/hooks';
import { SEARCH_ENTRY } from '@/lib/nav/items';
import { useHydrated, useLibraryList, useRecentlyPlayedAlbums } from '@/lib/store/hooks';
import type { AlbumView, ArtistView } from '@/lib/store/selectors';
import { HomeSkeleton } from './library/skeletons';

export const PLAYED_ALBUMS = 4;
export const RECENT_ITEMS = 12;
export const READY_TRACKS = 10;
const READY: ['found', 'ready'] = ['found', 'ready'];

const GRID = 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6';

type Recent = { key: string; at: number; album?: AlbumView; artist?: ArtistView };

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);

/** Альбомы и артисты, чья дискография ещё импортируется (альбомов пока нет), — новые сверху. */
export function recentItems(albums: AlbumView[], artists: ArtistView[], limit = RECENT_ITEMS): Recent[] {
  const items: Recent[] = [
    ...albums.slice(0, limit).map(album => ({ album, at: at(album.added_at), key: `album:${album.id}` })),
    ...artists
      .filter(a => a.albumCount === 0)
      .slice(0, limit)
      .map(artist => ({ artist, at: at(artist.added_at), key: `artist:${artist.id}` })),
  ];
  return items.sort((x, y) => y.at - x.at).slice(0, limit);
}

/** Главная: «Недавно слушали», «Недавно добавлено», «Готово к прослушиванию» — всё из локального store. */
export function Home() {
  const t = useT();
  const hydrated = useHydrated();
  const played = useRecentlyPlayedAlbums(PLAYED_ALBUMS);
  const albums = useLibraryList('albums');
  const artists = useLibraryList('artists');
  const readyAll = useLibraryList('tracks', READY);
  const online = useOnline();
  const canPlay = useCanPlay();
  if (!hydrated) return <HomeSkeleton />;
  // Без связи «готово к прослушиванию» — только то, что есть на устройстве.
  const ready = online ? readyAll : readyAll.filter(canPlay);

  const recent = recentItems(albums, artists);
  const readyTracks = ready.slice(0, READY_TRACKS);
  const readyIds = ready.map(tr => tr.id);

  if (recent.length === 0 && readyTracks.length === 0) {
    return (
      <PageLayout brand title={t('page.home.title')}>
        <EmptyState body={t('home.findMusic.body')} title={t('home.findMusic.title')}>
          <Link
            className="bg-accent hover:bg-accent-hover inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold text-white"
            to={SEARCH_ENTRY}
          >
            <Search aria-hidden className="size-4" />
            {t('library.empty.cta')}
          </Link>
        </EmptyState>
      </PageLayout>
    );
  }

  return (
    <PageLayout brand title={t('page.home.title')}>
      <div className="flex flex-col gap-10">
        {played.length > 0 ? (
          <section aria-labelledby="home-played" data-testid="home-played">
            <h2 className="mb-4" id="home-played">
              {t('home.played')}
            </h2>
            <ul className={GRID}>
              {played.map((a, i) => (
                <li key={a.id}>
                  <AlbumCard actions={<PlayAlbumButton albumId={a.id} variant="icon" />} album={a} priority={i < 4} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {recent.length > 0 ? (
          <section aria-labelledby="home-recent" data-testid="home-recent">
            <h2 className="mb-4" id="home-recent">
              {t('home.recent')}
            </h2>
            <ul className={GRID}>
              {recent.map((r, i) => (
                <li key={r.key}>
                  {r.album ? (
                    <AlbumCard
                      actions={<PlayAlbumButton albumId={r.album.id} variant="icon" />}
                      album={r.album}
                      priority={i < 4}
                    />
                  ) : r.artist ? <ArtistCard artist={r.artist} /> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section aria-labelledby="home-ready" data-testid="home-ready">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id="home-ready">{t(online ? 'home.ready' : 'home.readyOffline')}</h2>
            {readyTracks.length > 0 ? <PlayTracksButton testId="play-ready" tracks={ready} /> : null}
          </div>
          {readyTracks.length === 0 ? (
            <p className="text-muted text-sm">{t(online ? 'home.readyEmpty' : 'home.readyOfflineEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {readyTracks.map(tr => (
                <li key={tr.id}>
                  <PlayableTrackRow id={tr.id} queueIds={readyIds} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PageLayout>
  );
}
