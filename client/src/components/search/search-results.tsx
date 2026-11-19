import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArtistAvatar } from '@/components/library/artist-avatar';
import { Cover } from '@/components/library/cover';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { AlbumGridSkeleton, SectionHeadingSkeleton, TrackListSkeleton } from '@/screens/library/skeletons';
import { Spinner } from '@/components/ui/spinner';
import type { AlbumResult, ArtistResult, TrackResult } from '@/lib/api/search-types';
import { useT } from '@/lib/i18n/provider';
import { SCROLL_X_ATTR } from '@/lib/nav/use-scroll-restoration';
import type { AddRequest } from '@/lib/search/add';
import { addToHistory, clearHistory, useSearchHistory } from '@/lib/search/history';
import type { RemoteSearch } from '@/lib/search/use-remote-search';
import type { MbidIndex, SearchResult } from '@/lib/store/selectors';
import { formatDuration } from '@/lib/utils';
import { AddToLibraryButton, InLibrary } from './add-to-library-button';
import { albumHref, albumLink, albumSubtitle, artistHref, catalogArtistHref, pickBestArtist } from './helpers';
import { RemotePlayRow } from './remote-play';

type Props = {
  query: string;
  local: SearchResult;
  remote: RemoteSearch;
  index: MbidIndex;
  online: boolean;
};

const rowLink =
  'hover:bg-card/60 dark:hover:bg-card-dark/60 focus-visible:ring-accent/40 flex min-w-0 flex-1 items-center gap-3 rounded-md p-2 focus-visible:ring-2 focus-visible:outline-none';

const artistInput = (artist: ArtistResult): AddRequest => ({
  mbid: artist.mbid,
  preview: { title: artist.name },
  type: 'artist',
});

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
            <RemotePlayRow
              className="hover:bg-card/60 dark:hover:bg-card-dark/60 p-2"
              leading={<Cover alt={tr.albumTitle} className="size-10" src={tr.coverUrl} />}
              query={query}
              request={{ albumMbid: null, mbid: tr.mbid_recording, title: tr.title, trackId: tr.id }}
            >
              <span className="truncate text-sm font-medium">{tr.title}</span>
              <span className="text-muted truncate text-xs">
                {t('kind.track')} · {tr.artistName} · {tr.albumTitle}
              </span>
            </RemotePlayRow>
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
      <Link
        className="focus-visible:ring-accent/40 flex flex-col items-center rounded-lg transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
        onClick={() => addToHistory(query)}
        to={catalogArtistHref(artist.mbid)}
      >
        {body}
      </Link>
      <div className="mt-2">
        <AddToLibraryButton input={artistInput(artist)} libraryHref={href} query={query} />
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
      <Link
        className="focus-visible:ring-accent/40 block rounded-md focus-visible:ring-2 focus-visible:outline-none"
        onClick={() => addToHistory(query)}
        to={albumLink(album.mbid, index)}
      >
        <Cover alt={album.title} className="w-full shadow-lg" src={album.cover_url} />
        <div className="mt-3 min-w-0">
          <p className="line-clamp-2 text-sm font-semibold hover:underline">{album.title}</p>
          <p className="text-muted line-clamp-2 text-xs">{albumSubtitle(album, t)}</p>
        </div>
      </Link>
      <div className="mt-3 flex justify-end">
        <AddToLibraryButton
          input={{
            mbid: album.mbid,
            preview: { artistName: album.artist_name, cover: album.cover_url, title: album.title },
            type: 'album',
          }}
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
      <RemotePlayRow
        leading={<Cover alt={track.album_title ?? track.title} className="size-10" src={track.cover_url} />}
        query={query}
        request={{ albumMbid: track.album_mbid ?? null, mbid: track.mbid, title: track.title }}
      >
        <span className="truncate text-sm font-medium">{track.title}</span>
        <span className="text-muted truncate text-xs">
          {[track.artist_name, track.album_title].filter(Boolean).join(' · ')}
        </span>
      </RemotePlayRow>
      {track.duration_ms ? (
        <span className="text-muted font-mono text-xs">{formatDuration(Math.floor(track.duration_ms / 1000))}</span>
      ) : null}
      <AddToLibraryButton
        input={{
          albumMbid: track.album_mbid,
          mbid: track.mbid,
          preview: { artistName: track.artist_name, cover: track.cover_url, title: track.title },
          type: 'track',
        }}
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
          <Link
            className="focus-visible:ring-accent/40 flex flex-col gap-4 rounded-md focus-visible:ring-2 focus-visible:outline-none"
            data-testid="best-artist-link"
            onClick={() => addToHistory(query)}
            to={catalogArtistHref(artist.mbid)}
          >
            <ArtistAvatar className="h-24 w-24 text-3xl" mbid={artist.mbid} name={artist.name} />
            <span className="min-w-0">
              <span className="block truncate text-2xl font-bold tracking-tight hover:underline">{artist.name}</span>
              <span className="text-muted block truncate text-sm">
                {[t('kind.artist'), artist.disambiguation, artist.country].filter(Boolean).join(' · ')}
              </span>
            </span>
          </Link>
          <div>
            {id === undefined ? (
              <AddToLibraryButton input={artistInput(artist)} libraryHref={null} query={query} />
            ) : (
              <InLibrary />
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

/** Скелет результатов: те же секции (заголовок, артисты, сетка альбомов, треки), что и у готового поиска. */
export function RemoteSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-10" data-testid="search-skeleton">
      <div>
        <SectionHeadingSkeleton />
        <div className="flex gap-5 pb-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div className="flex w-28 shrink-0 flex-col items-center" key={i}>
              <Skeleton className="size-28 rounded-full" />
              <Skeleton className="mt-3 h-5 w-20" />
              <Skeleton className="mt-2 h-8 w-20 rounded-full" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <SectionHeadingSkeleton />
        <AlbumGridSkeleton count={5} />
      </div>
      <div>
        <SectionHeadingSkeleton />
        <TrackListSkeleton count={4} />
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

/** После этой паузы статус поиска поясняет, что MusicBrainz отвечает не сразу. */
export const SLOW_SEARCH_MS = 2500;

/**
 * Что сейчас делает поиск — словами, а не только скелетом: ищем, ищем долго, MusicBrainz не ответил и мы
 * повторяем запрос сами. Таймер «долго» начинается заново с каждым новым запросом (компонент монтируется заново).
 */
export function SearchProgress({
  retrying,
  partial = false,
  loadingText,
}: {
  retrying: boolean;
  partial?: boolean;
  /** Текст обычного ожидания вместо «Ищем в MusicBrainz…» (экраны каталога). */
  loadingText?: string;
}) {
  const t = useT();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_SEARCH_MS);
    return () => clearTimeout(timer);
  }, []);
  const title = partial
    ? t('search.partialRetrying')
    : retrying
      ? t('search.retrying')
      : (loadingText ?? t('search.searching'));
  const body = retrying ? t('search.retryingBody') : slow ? t('search.slowBody') : null;
  return (
    <div
      className="bg-card/50 dark:bg-card-dark/50 flex items-start gap-3 rounded-lg px-4 py-3"
      data-retrying={retrying || undefined}
      data-testid="search-progress"
      role="status"
    >
      {retrying ? (
        <AlertTriangle aria-hidden className="text-warning-fg mt-0.5 size-5 shrink-0" />
      ) : (
        <Spinner className="text-accent-fg mt-0.5 size-5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          {title}
          {retrying ? <Spinner className="text-muted size-3.5" /> : null}
        </p>
        {body ? <p className="text-muted text-xs">{body}</p> : null}
      </div>
    </div>
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
    return remote.loading ? (
      <div className="flex flex-col gap-8" key={query}>
        <SearchProgress retrying={remote.retrying} />
        <RemoteSkeleton />
      </div>
    ) : null;
  }
  const total = data.artists.length + data.albums.length + data.tracks.length;
  if (total === 0 && remote.retrying) {
    // MusicBrainz не ответил ни по одной секции: «ничего не найдено» было бы неправдой — ищем дальше.
    return (
      <div className="flex flex-col gap-8">
        <SearchProgress retrying />
        <RemoteSkeleton />
      </div>
    );
  }
  const best = pickBestArtist(data);
  return (
    <div className="flex flex-col gap-10" data-testid="search-results">
      {remote.retrying ? <SearchProgress partial retrying /> : null}
      {total === 0 ? <EmptyState body={t('search.noneBody', { query: data.query })} title={t('search.none')} /> : null}
      {best && data.tracks.length > 0 ? (
        <BestResult artist={best} index={index} query={query} tracks={data.tracks.slice(0, 4)} />
      ) : null}
      {data.artists.length > 0 ? (
        <Section id="search-artists" title={t('group.artists')}>
          <ul className="flex gap-5 overflow-x-auto pb-2" {...{ [SCROLL_X_ATTR]: 'search-artists' }}>
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
