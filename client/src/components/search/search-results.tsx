import { Link } from 'react-router';
import { ArtistAvatar } from '@/components/library/artist-avatar';
import { Cover } from '@/components/library/cover';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import type { AlbumResult, ArtistResult, TrackResult } from '@/lib/api/search-types';
import { useT } from '@/lib/i18n/provider';
import { addToHistory, clearHistory, useSearchHistory } from '@/lib/search/history';
import type { RemoteSearch } from '@/lib/search/use-remote-search';
import type { MbidIndex, SearchResult } from '@/lib/store/selectors';
import { cn, formatDuration } from '@/lib/utils';
import { AddToLibraryButton, InLibrary } from './add-to-library-button';
import { albumHref, albumSubtitle, artistHref, pickBestArtist } from './helpers';

type Props = {
  query: string;
  local: SearchResult;
  remote: RemoteSearch;
  index: MbidIndex;
  online: boolean;
};

const rowLink =
  'hover:bg-card/60 dark:hover:bg-card-dark/60 focus-visible:ring-accent/40 flex min-w-0 flex-1 items-center gap-3 rounded-md p-2 focus-visible:ring-2 focus-visible:outline-none';

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} data-testid={id}>
      <h2 className="mb-4" id={id}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Совпадения в локальной библиотеке: видны сразу, без сети. */
function LocalResults({ local, query }: { local: SearchResult; query: string }) {
  const t = useT();
  if (local.artists.length + local.albums.length + local.tracks.length === 0) return null;
  const remember = () => addToHistory(query);
  return (
    <Section id="search-local" title={t('search.local')}>
      <ul className="flex flex-col gap-0.5">
        {local.artists.map(a => (
          <li key={`artist-${a.id}`}>
            <Link className={rowLink} onClick={remember} to={artistHref(a.id)}>
              <ArtistAvatar className="size-10 text-xs" mbid={a.mbid} name={a.name} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{a.name}</span>
                <span className="text-muted truncate text-xs">{t('kind.artist')}</span>
              </span>
            </Link>
          </li>
        ))}
        {local.albums.map(a => (
          <li key={`album-${a.id}`}>
            <Link className={rowLink} onClick={remember} to={albumHref(a.id)}>
              <Cover alt={a.title} className="size-10" src={a.cover_url} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{a.title}</span>
                <span className="text-muted truncate text-xs">
                  {t('kind.album')} · {a.artistName}
                </span>
              </span>
            </Link>
          </li>
        ))}
        {local.tracks.map(tr => (
          <li key={`track-${tr.id}`}>
            <Link className={rowLink} onClick={remember} to={albumHref(tr.album_id)}>
              <Cover alt={tr.albumTitle} className="size-10" src={tr.coverUrl} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{tr.title}</span>
                <span className="text-muted truncate text-xs">
                  {t('kind.track')} · {tr.artistName} · {tr.albumTitle}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ArtistCard({ artist, index, query }: { artist: ArtistResult; index: MbidIndex; query: string }) {
  const id = index.artists.get(artist.mbid);
  const href = id === undefined ? null : artistHref(id);
  const body = (
    <>
      <ArtistAvatar className="h-28 w-28 text-3xl" mbid={artist.mbid} name={artist.name} />
      <span className="mt-3 line-clamp-2 text-center text-sm font-semibold">{artist.name}</span>
      {artist.disambiguation ? (
        <span className="text-muted line-clamp-1 text-center text-xs">{artist.disambiguation}</span>
      ) : null}
    </>
  );
  return (
    <div className="flex flex-col items-center" data-testid="remote-artist">
      <div className="flex flex-col items-center">{body}</div>
      <div className="mt-2">
        <AddToLibraryButton input={{ mbid: artist.mbid, type: 'artist' }} libraryHref={href} query={query} />
      </div>
    </div>
  );
}

function AlbumCard({ album, index, query }: { album: AlbumResult; index: MbidIndex; query: string }) {
  const t = useT();
  const id = index.albums.get(album.mbid);
  return (
    <div
      className="bg-card/50 dark:bg-card-dark/50 flex h-full flex-col justify-between rounded-lg p-3"
      data-testid="remote-album"
    >
      <div>
        <Cover alt={album.title} className="w-full shadow-lg" src={album.cover_url} />
        <div className="mt-3 min-w-0">
          <p className="line-clamp-2 text-sm font-semibold">{album.title}</p>
          <p className="text-muted line-clamp-2 text-xs">{albumSubtitle(album, t)}</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <AddToLibraryButton
          input={{ mbid: album.mbid, type: 'album' }}
          libraryHref={id === undefined ? null : albumHref(id)}
          query={query}
        />
      </div>
    </div>
  );
}

function TrackRow({ track, index, query }: { track: TrackResult; index: MbidIndex; query: string }) {
  const own = index.tracks.get(track.mbid);
  return (
    <div
      className="hover:bg-card/60 dark:hover:bg-card-dark/60 flex items-center gap-3 rounded-md px-2 py-1.5"
      data-testid="remote-track"
    >
      <Cover alt={track.album_title ?? track.title} className="size-10" src={track.cover_url} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{track.title}</span>
        <span className="text-muted truncate text-xs">
          {[track.artist_name, track.album_title].filter(Boolean).join(' · ')}
        </span>
      </div>
      {track.duration_ms ? (
        <span className="text-muted font-mono text-xs">{formatDuration(Math.floor(track.duration_ms / 1000))}</span>
      ) : null}
      <AddToLibraryButton
        input={{ albumMbid: track.album_mbid, mbid: track.mbid, type: 'track' }}
        libraryHref={own ? albumHref(own.albumId) : null}
        query={query}
      />
    </div>
  );
}

function BestResult({
  artist,
  tracks,
  index,
  query,
}: {
  artist: ArtistResult;
  tracks: TrackResult[];
  index: MbidIndex;
  query: string;
}) {
  const t = useT();
  const id = index.artists.get(artist.mbid);
  return (
    <section
      aria-labelledby="search-best"
      className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <div>
        <h2 className="mb-4" id="search-best">
          {t('search.best')}
        </h2>
        <div className="bg-card/60 dark:bg-card-dark/60 flex flex-col gap-4 rounded-lg p-5">
          <ArtistAvatar className="h-24 w-24 text-3xl" mbid={artist.mbid} name={artist.name} />
          <div className="min-w-0">
            <p className="truncate text-2xl font-bold tracking-tight">{artist.name}</p>
            <p className="text-muted truncate text-sm">
              {[t('kind.artist'), artist.disambiguation, artist.country].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div>
            {id === undefined ? (
              <AddToLibraryButton input={{ mbid: artist.mbid, type: 'artist' }} libraryHref={null} query={query} />
            ) : (
              <InLibrary href={artistHref(id)} query={query} />
            )}
          </div>
        </div>
      </div>
      <div>
        <h2 className="mb-4">{t('search.bestTracks')}</h2>
        <ul className="flex flex-col gap-0.5">
          {tracks.map(tr => (
            <li key={tr.mbid}>
              <TrackRow index={index} query={query} track={tr} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function RemoteSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-8" data-testid="search-skeleton">
      <div className="flex gap-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton className="size-28 shrink-0 rounded-full" key={i} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton className="aspect-square rounded-lg" key={i} />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton className="h-12 w-full" key={i} />
        ))}
      </div>
    </div>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <Button onClick={onRetry} size="sm" variant="secondary">
      {t('common.retry')}
    </Button>
  );
}

function RemoteResults({ remote, index, query }: { remote: RemoteSearch; index: MbidIndex; query: string }) {
  const t = useT();
  const { data } = remote;
  if (!data) {
    if (remote.error) {
      return (
        <ErrorState body={remote.error.message} title={t('search.failed')}>
          <RetryButton onRetry={remote.retry} />
        </ErrorState>
      );
    }
    return remote.loading ? <RemoteSkeleton /> : null;
  }
  const total = data.artists.length + data.albums.length + data.tracks.length;
  if (total === 0 && data.errors.length > 0) {
    // Все три запроса к MusicBrainz не удались: сервер отвечает 200, но показывать «ничего не найдено» нечестно.
    return (
      <ErrorState body={data.errors.join('; ')} title={t('error.mb_unavailable')}>
        <RetryButton onRetry={remote.retry} />
      </ErrorState>
    );
  }
  const best = pickBestArtist(data);
  return (
    <div
      aria-busy={remote.stale}
      className={cn('flex flex-col gap-10 transition-opacity duration-200', remote.stale && 'opacity-50')}
      data-stale={remote.stale || undefined}
      data-testid="search-results"
    >
      {remote.error ? (
        <ErrorState body={remote.error.message} compact title={t('search.updateFailed')}>
          <RetryButton onRetry={remote.retry} />
        </ErrorState>
      ) : null}
      {data.errors.length > 0 ? (
        <ErrorState body={data.errors.join('; ')} compact title={t('search.partial')}>
          <RetryButton onRetry={remote.retry} />
        </ErrorState>
      ) : null}
      {total === 0 ? <EmptyState body={t('search.noneBody', { query: data.query })} title={t('search.none')} /> : null}
      {best && data.tracks.length > 0 ? (
        <BestResult artist={best} index={index} query={query} tracks={data.tracks.slice(0, 4)} />
      ) : null}
      {data.artists.length > 0 ? (
        <Section id="search-artists" title={t('group.artists')}>
          <ul className="flex gap-5 overflow-x-auto pb-2">
            {data.artists.map(a => (
              <li className="w-28 shrink-0" key={a.mbid}>
                <ArtistCard artist={a} index={index} query={query} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {data.albums.length > 0 ? (
        <Section id="search-albums" title={t('group.albums')}>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {data.albums.map(a => (
              <li key={a.mbid}>
                <AlbumCard album={a} index={index} query={query} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {data.tracks.length > 0 ? (
        <Section id="search-tracks" title={t('group.tracks')}>
          <ul className="flex flex-col gap-0.5">
            {data.tracks.map(tr => (
              <li key={tr.mbid}>
                <TrackRow index={index} query={query} track={tr} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/** Пустой ввод: подсказка и история запросов. */
export function SearchIdle() {
  const t = useT();
  const history = useSearchHistory();
  return (
    <div className="flex flex-col gap-8" data-testid="search-idle">
      <EmptyState body={t('search.prompt.body')} title={t('search.prompt.title')} />
      {history.length > 0 ? (
        <Section id="search-history" title={t('search.history')}>
          <ul className="flex flex-wrap items-center gap-2">
            {history.map(q => (
              <li key={q}>
                <Link
                  className="border-divider dark:border-divider-dark hover:bg-card dark:hover:bg-card-dark focus-visible:ring-accent/40 rounded-full border px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
                  replace
                  to={`/search?q=${encodeURIComponent(q)}`}
                >
                  {q}
                </Link>
              </li>
            ))}
            <li>
              <Button onClick={clearHistory} size="sm" variant="ghost">
                {t('search.historyClear')}
              </Button>
            </li>
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/** Результаты: локальные — сразу, MusicBrainz — по мере прихода; все состояния (пусто, загрузка, ошибка, офлайн). */
export function SearchResults({ query, local, remote, index, online }: Props) {
  const t = useT();
  const trimmed = query.trim();
  if (!trimmed) return <SearchIdle />;
  const hasLocal = local.artists.length + local.albums.length + local.tracks.length > 0;
  return (
    <div className="flex flex-col gap-10" data-testid="search-view-results">
      <LocalResults local={local} query={trimmed} />
      {!online ? (
        <p className="text-muted text-sm" data-testid="search-offline" role="status">
          {t('search.offline')}
        </p>
      ) : (
        <RemoteResults index={index} query={trimmed} remote={remote} />
      )}
      {!online && !hasLocal ? (
        <EmptyState body={t('search.noneBody', { query: trimmed })} title={t('search.none')} />
      ) : null}
      {online && !remote.active && !hasLocal ? (
        <EmptyState body={t('search.noneBody', { query: trimmed })} title={t('search.none')} />
      ) : null}
    </div>
  );
}
