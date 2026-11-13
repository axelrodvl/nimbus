'use client';

import { Disc3 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Cover } from '@/components/ui/cover';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { toPlayerTrack } from '@/features/library/to-player-track';
import { AddToLibraryButton, InLibraryBadge } from '@/features/search/components/add-to-library-button';
import { ArtistAvatar } from '@/features/search/components/artist-avatar';
import type { SearchStatus, SearchResponse } from '@/hooks/use-search';
import { api } from '@/lib/api/client';
import type { Schemas } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { cn, formatDuration } from '@/lib/utils';
import { useT } from '@/providers/i18n-provider';
import { usePlayer } from '@/providers/player-provider';
import type { Route } from 'next';

type Artist = Schemas['ArtistResult'];
type Album = Schemas['AlbumResult'];
type Track = Schemas['TrackResult'];

export const artistHref = (libraryId: number) => `/artist/${libraryId}` as Route;
export const albumHref = (libraryId: number) => `/album/${libraryId}` as Route;

export function albumSubtitle(a: Album) {
  const parts = [a.artist_name, a.year ? String(a.year) : null, a.primary_type];
  return parts.filter(Boolean).join(' · ');
}

type Props = {
  status: SearchStatus;
  data: SearchResponse | undefined;
  stale: boolean;
  error: string | undefined;
  query: string;
  onRetry: () => void;
};

export function SearchResults({ status, data, stale, error, query, onRetry }: Props) {
  const t = useT();
  if (status === 'idle') {
    return <EmptyState title={t('search.prompt.title')} body={t('search.prompt.body')} />;
  }
  if (!data) {
    if (status === 'error') {
      return (
        <ErrorState title={t('search.failed')} body={error}>
          <RetryButton onRetry={onRetry} />
        </ErrorState>
      );
    }
    return <SearchSkeleton />;
  }

  const total = data.artists.length + data.albums.length + data.tracks.length;
  return (
    <div
      className={cn('flex flex-col gap-10 transition-opacity duration-200', stale && 'opacity-50')}
      aria-busy={stale}
      data-testid="search-results"
    >
      {status === 'error' ? (
        <ErrorState compact title={t('search.updateFailed')} body={error}>
          <RetryButton onRetry={onRetry} />
        </ErrorState>
      ) : null}
      {data.errors.length > 0 ? (
        <ErrorState compact title={t('search.partial')} body={data.errors.join('; ')}>
          <RetryButton onRetry={onRetry} />
        </ErrorState>
      ) : null}
      {total === 0 && data.errors.length === 0 ? (
        <EmptyState title={t('search.none')} body={t('search.noneBody', { query: data.query || query })} />
      ) : null}
      <BestResult artist={pickBestArtist(data)} tracks={data.tracks.slice(0, 4)} />
      {data.artists.length > 0 ? (
        <section aria-labelledby="search-artists">
          <h2 id="search-artists" className="mb-4">
            {t('group.artists')}
          </h2>
          <ul className="flex gap-5 overflow-x-auto pb-2">
            {data.artists.map(a => (
              <li key={a.mbid} className="w-28 shrink-0">
                <ArtistCard artist={a} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.albums.length > 0 ? (
        <section aria-labelledby="search-albums">
          <h2 id="search-albums" className="mb-4">
            {t('group.albums')}
          </h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {data.albums.map(a => (
              <li key={a.mbid}>
                <AlbumCard album={a} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.tracks.length > 0 ? (
        <section aria-labelledby="search-tracks">
          <h2 id="search-tracks" className="mb-4">
            {t('group.tracks')}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {data.tracks.map(t => (
              <li key={t.mbid}>
                <TrackRow track={t} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onRetry}
      className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark rounded-full border px-3 py-1.5 text-xs font-semibold"
    >
      {t('common.retry')}
    </button>
  );
}

const norm = (s: string) => s.trim().toLowerCase();

/** Запрос = название трека («Nothing Else Matters») → лучший артист — исполнитель топового трека,
 * а не случайный артист с похожим именем. Если имя артиста совпало с запросом — он и лучший. */
function pickBestArtist(data: SearchResponse): Artist | undefined {
  const q = norm(data.query);
  const exact = data.artists.find(a => norm(a.name) === q);
  if (exact) return exact;
  const top = data.tracks[0];
  if (top && norm(top.title) === q) {
    return (
      data.artists.find(a => a.mbid === top.artist_mbid) ?? {
        country: null,
        disambiguation: null,
        library_id: null,
        mbid: top.artist_mbid,
        name: top.artist_name,
        score: top.score,
      }
    );
  }
  return data.artists[0];
}

function BestResult({ artist, tracks }: { artist: Artist | undefined; tracks: Track[] }) {
  const t = useT();
  if (!artist || tracks.length === 0) return null;
  return (
    <section
      aria-labelledby="search-best"
      className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <div>
        <h2 id="search-best" className="mb-4">
          {t('search.best')}
        </h2>
        <div className="bg-card/60 dark:bg-card-dark/60 flex flex-col gap-4 rounded-lg p-5">
          <ArtistAvatar mbid={artist.mbid} name={artist.name} className="h-24 w-24 text-3xl" />
          <div className="min-w-0">
            <p className="truncate text-2xl font-bold tracking-tight">{artist.name}</p>
            <p className="text-muted truncate text-sm">
              {t('kind.artist')}
              {artist.disambiguation ? ` · ${artist.disambiguation}` : ''}
              {artist.country ? ` · ${artist.country}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {artist.library_id != null ? (
              <>
                <InLibraryBadge />
                <Link href={artistHref(artist.library_id)} className="text-accent text-sm font-medium hover:underline">
                  {t('search.open')}
                </Link>
              </>
            ) : (
              <AddToLibraryButton type="artist" mbid={artist.mbid} />
            )}
          </div>
        </div>
      </div>
      <div>
        <h2 className="mb-4">{t('search.bestTracks')}</h2>
        <ul className="flex flex-col gap-0.5">
          {tracks.map(t => (
            <li key={t.mbid}>
              <TrackRow track={t} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ArtistCard({ artist }: { artist: Artist }) {
  const body = (
    <>
      <ArtistAvatar mbid={artist.mbid} name={artist.name} className="h-28 w-28 text-3xl" />
      <span className="mt-3 line-clamp-2 text-center text-sm font-semibold">{artist.name}</span>
      {artist.disambiguation ? (
        <span className="text-muted line-clamp-1 text-center text-xs">{artist.disambiguation}</span>
      ) : null}
    </>
  );
  return (
    <div className="flex flex-col items-center">
      {artist.library_id != null ? (
        <Link href={artistHref(artist.library_id)} className="flex flex-col items-center">
          {body}
        </Link>
      ) : (
        <div className="flex flex-col items-center">{body}</div>
      )}
      <div className="mt-2">
        {artist.library_id != null ? <InLibraryBadge /> : <AddToLibraryButton type="artist" mbid={artist.mbid} />}
      </div>
    </div>
  );
}

function AlbumCard({ album }: { album: Album }) {
  const inLibrary = album.library_id != null;
  const body = (
    <>
      <Cover
        src={album.cover_url}
        alt={album.title}
        size="lg"
        className="aspect-square !h-auto !w-full shadow-lg"
        fallback={<Disc3 className="h-1/3 w-1/3 text-white/70" aria-hidden />}
      />
      <div className="mt-3 min-w-0">
        <p className="line-clamp-2 text-sm font-semibold">{album.title}</p>
        <p className="text-muted line-clamp-2 text-xs">{albumSubtitle(album)}</p>
      </div>
    </>
  );
  return (
    <div className="bg-card/50 hover:bg-card dark:bg-card-dark/50 dark:hover:bg-card-dark flex h-full flex-col justify-between rounded-lg p-3 transition-colors">
      {inLibrary ? <Link href={albumHref(album.library_id!)}>{body}</Link> : <div>{body}</div>}
      <div className="mt-3 flex justify-end">
        {inLibrary ? <InLibraryBadge /> : <AddToLibraryButton type="album" mbid={album.mbid} />}
      </div>
    </div>
  );
}

function TrackRow({ track }: { track: Track }) {
  const player = usePlayer();
  const [albumId, setAlbumId] = useState<number | null>(track.album_library_id ?? null);
  const trackId = track.library_id ?? null;
  const inLibrary = trackId != null || albumId != null;
  const canPlay = trackId != null && (track.status == null || track.status === 'found' || track.status === 'ready');

  // Клик по тексту трека в библиотеке — воспроизведение (а не переход к альбому).
  async function play() {
    if (trackId == null) return;
    if (player.track?.id === trackId) {
      if (player.isPlaying) player.pause();
      else player.resume();
      return;
    }
    try {
      const dto = unwrap(await api.GET('/api/tracks/{id}', { params: { path: { id: trackId } } }));
      player.play(toPlayerTrack(dto));
    } catch {
      // Трек недоступен — ничего не делаем.
    }
  }

  const info = (
    <>
      <Cover src={track.cover_url} alt={track.album_title ?? track.title} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{track.title}</span>
        <span className="text-muted truncate text-xs">
          {track.artist_name}
          {track.album_title ? ` · ${track.album_title}` : ''}
        </span>
      </div>
      {track.duration_ms ? (
        <span className="text-muted font-mono text-xs">{formatDuration(Math.floor(track.duration_ms / 1000))}</span>
      ) : null}
    </>
  );
  const infoClass = 'flex min-w-0 flex-1 items-center gap-3';
  return (
    <div className="hover:bg-card/60 dark:hover:bg-card-dark/60 flex items-center gap-3 rounded-md px-3 py-2 transition-colors">
      {canPlay ? (
        <button type="button" onClick={play} className={cn(infoClass, 'cursor-pointer text-left')}>
          {info}
        </button>
      ) : albumId != null ? (
        <Link href={albumHref(albumId)} className={infoClass}>
          {info}
        </Link>
      ) : (
        <div className={infoClass}>{info}</div>
      )}
      {inLibrary ? (
        <InLibraryBadge />
      ) : (
        <AddToLibraryButton
          type="track"
          mbid={track.mbid}
          albumMbid={track.album_mbid}
          onAdded={r => {
            setAlbumId(r.albumId ?? null);
          }}
        />
      )}
    </div>
  );
}

export function SearchSkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-hidden data-testid="search-skeleton">
      <div>
        <Skeleton className="mb-4 h-6 w-24" />
        <div className="flex gap-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex w-28 flex-col items-center gap-3">
              <Skeleton className="h-28 w-28 rounded-full" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <Skeleton className="mb-4 h-6 w-24" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-3 p-3">
              <Skeleton className="aspect-square w-full rounded-md" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <Skeleton className="mb-4 h-6 w-24" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2">
            <Skeleton className="h-10 w-10 rounded-md" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
