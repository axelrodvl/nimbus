import { ArrowLeft, Play } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ArtistAvatar } from '@/components/library/artist-avatar';
import { Cover } from '@/components/library/cover';
import { PageLayout } from '@/components/page-layout';
import { PlayAlbumButton } from '@/components/player/play-buttons';
import { AddToLibraryButton, InLibrary } from '@/components/search/add-to-library-button';
import { albumHref, albumLink, artistHref, catalogArtistHref } from '@/components/search/helpers';
import { RemotePlayRow } from '@/components/search/remote-play';
import { SearchProgress } from '@/components/search/search-results';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import type { CatalogAlbumResponse, CatalogArtistResponse } from '@/lib/api/catalog';
import { ApiError } from '@/lib/api/errors';
import type { AlbumResult } from '@/lib/api/search-types';
import { useT } from '@/lib/i18n/provider';
import { albumTypeLabel } from '@/lib/library/status';
import { useOnline } from '@/lib/live/hooks';
import {
  groupDiscography,
  useCatalogAlbum,
  useCatalogArtist,
  type CatalogQuery,
  type DiscographySection,
} from '@/lib/search/catalog';
import { playRemoteApp, usePlayAlbumPending } from '@/lib/search/play-remote';
import { useAlbumTracksByMbid, useMbidIndex } from '@/lib/store/hooks';
import type { MbidIndex } from '@/lib/store/selectors';
import { formatDuration } from '@/lib/utils';
import { AlbumGridSkeleton, TrackListSkeleton } from './library/skeletons';

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRID = 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

const SECTION_LABEL = {
  albums: 'artist.albums',
  compilations: 'catalog.compilations',
  eps: 'artist.group.ep',
  live: 'catalog.live',
  other: 'artist.group.other',
} as const satisfies Record<DiscographySection, string>;

/** «Назад» к результатам поиска: история браузера, а если экран открыт по ссылке — на поиск. */
function BackButton() {
  const t = useT();
  const navigate = useNavigate();
  // `default` — экран открыт первым (по ссылке): «назад» по истории увёл бы из приложения.
  const first = useLocation().key === 'default';
  return (
    <button
      className="text-muted focus-visible:ring-accent/40 mb-4 inline-flex items-center gap-1 rounded text-sm font-medium hover:text-black focus-visible:ring-2 focus-visible:outline-none dark:hover:text-white"
      data-testid="catalog-back"
      onClick={() => (first ? navigate('/search') : navigate(-1))}
      type="button"
    >
      <ArrowLeft aria-hidden className="size-4" />
      {t('common.back')}
    </button>
  );
}

/** Общие состояния экрана каталога: офлайн, загрузка (спиннер со статусом + skeleton), «нет в MusicBrainz», ошибка. */
function CatalogGate<T>({
  query,
  skeleton,
  children,
}: {
  query: CatalogQuery<T>;
  skeleton: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  const t = useT();
  const online = useOnline();
  if (query.data) return <>{children(query.data)}</>;
  if (!online) {
    return <EmptyState body={t('catalog.offlineBody')} title={t('catalog.offline')} />;
  }
  if (query.error) {
    if (query.error.status === 404 || query.error.status === 400) {
      return <EmptyState body={t('catalog.notFoundBody')} title={t('catalog.notFound')} />;
    }
    return (
      <ErrorState body={query.error.message} title={t('common.loadFailed')}>
        <Button onClick={query.retry} size="sm" variant="secondary">
          {t('common.retry')}
        </Button>
      </ErrorState>
    );
  }
  return (
    <div className="flex flex-col gap-8" data-testid="catalog-loading">
      <SearchProgress loadingText={t('catalog.loading')} retrying={query.retrying} />
      {skeleton}
    </div>
  );
}

function AlbumTile({ album, index }: { album: AlbumResult; index: MbidIndex }) {
  const t = useT();
  const subtitle = [album.year ? String(album.year) : null, albumTypeLabel(album.primary_type, t)]
    .filter(Boolean)
    .join(' · ');
  return (
    <Link
      className="hover:bg-card/60 dark:hover:bg-card-dark/60 focus-visible:ring-accent/40 flex flex-col rounded-lg p-3 focus-visible:ring-2 focus-visible:outline-none"
      data-testid="catalog-album"
      to={albumLink(album.mbid, index)}
    >
      <Cover alt={album.title} className="w-full shadow-lg" src={album.cover_url} />
      <span className="mt-3 line-clamp-2 text-sm font-semibold">{album.title}</span>
      <span className="text-muted line-clamp-1 text-xs">{subtitle}</span>
    </Link>
  );
}

function ArtistBody({ data, index }: { data: CatalogArtistResponse; index: MbidIndex }) {
  const t = useT();
  const { artist } = data;
  const libraryId = index.artists.get(artist.mbid);
  const sections = groupDiscography(data.albums);
  return (
    <>
      <header className="mb-10 flex flex-col items-center gap-5 sm:flex-row sm:items-end">
        <ArtistAvatar className="size-40 shrink-0 text-5xl shadow-2xl" mbid={artist.mbid} name={artist.name} />
        <div className="flex min-w-0 flex-col items-center gap-3 sm:items-start">
          <span className="text-muted text-xs font-medium tracking-wide uppercase">{t('kind.artist')}</span>
          <h1 className="text-center text-4xl font-bold tracking-tight sm:text-left">{artist.name}</h1>
          <p className="text-muted text-sm">
            {[artist.disambiguation, artist.country, t('count.albums', { count: data.albums.length })]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {libraryId === undefined ? (
            <AddToLibraryButton
              input={{ mbid: artist.mbid, preview: { title: artist.name }, type: 'artist' }}
              libraryHref={null}
            />
          ) : (
            <InLibrary href={artistHref(libraryId)} />
          )}
        </div>
      </header>
      {sections.length === 0 ? (
        <EmptyState body={t('catalog.emptyBody')} title={t('catalog.empty')} />
      ) : (
        <div className="flex flex-col gap-10">
          {sections.map(s => (
            <section aria-labelledby={`catalog-${s.section}`} data-testid={`catalog-${s.section}`} key={s.section}>
              <h2 className="mb-4" id={`catalog-${s.section}`}>
                {t(SECTION_LABEL[s.section])}
              </h2>
              <ul className={GRID}>
                {s.albums.map(a => (
                  <li key={a.mbid}>
                    <AlbumTile album={a} index={index} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

/** Артист из MusicBrainz `/search/artist/:mbid`: шапка и дискография по разделам; альбом открывается по нажатию. */
export function CatalogArtistScreen() {
  const raw = useParams().mbid ?? '';
  const valid = MBID.test(raw);
  const online = useOnline();
  const query = useCatalogArtist(raw, valid && online);
  const index = useMbidIndex();
  const t = useT();
  return (
    <PageLayout documentTitle={query.data?.artist.name ?? t('kind.artist')}>
      <BackButton />
      <CatalogGate
        query={valid ? query : invalidQuery}
        skeleton={
          <div className="flex flex-col gap-8">
            <div className="flex items-end gap-5">
              <Skeleton className="size-40 rounded-full" />
              <Skeleton className="h-10 w-64" />
            </div>
            <AlbumGridSkeleton />
          </div>
        }
      >
        {data => <ArtistBody data={data} index={index} />}
      </CatalogGate>
    </PageLayout>
  );
}

function AlbumBody({ data, index }: { data: CatalogAlbumResponse; index: MbidIndex }) {
  const t = useT();
  const { album, tracks } = data;
  const libraryId = index.albums.get(album.mbid);
  // Треки именно этого альбома в store (альбом сохраняется на сервере при открытии): «в библиотеке» и «играет» — по
  // ним, а не по записи вообще (та же запись бывает на сингле или сборнике).
  const ownTracks = useAlbumTracksByMbid(album.mbid);
  const byRecording = new Map<string, (typeof ownTracks)[number]>();
  for (const v of ownTracks) if (!byRecording.has(v.mbid_recording)) byRecording.set(v.mbid_recording, v);
  const multiDisc = new Set(tracks.map(tr => tr.disc_no)).size > 1;
  const first = tracks[0];
  const albumPending = usePlayAlbumPending(album.mbid);
  const totalMs = tracks.reduce((sum, tr) => sum + (tr.duration_ms ?? 0), 0);
  const request = (tr: (typeof tracks)[number], wholeAlbum = false) => ({
    albumMbid: album.mbid,
    context: 'album' as const,
    mbid: tr.mbid,
    title: wholeAlbum ? album.title : tr.title,
    trackId: byRecording.get(tr.mbid)?.id,
    wholeAlbum,
  });
  return (
    <>
      <header className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <Cover
          alt={album.title}
          className="size-48 shrink-0 self-center shadow-2xl sm:self-auto"
          priority
          src={album.cover_url}
          thumb={500}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <span className="text-muted text-xs font-medium tracking-wide uppercase">
            {albumTypeLabel(album.primary_type, t) ?? t('album.primaryDefault')}
          </span>
          <h1 className="text-4xl font-bold tracking-tight">{album.title}</h1>
          <p className="text-muted text-sm">
            <Link
              className="font-medium text-black hover:underline dark:text-white"
              data-testid="catalog-album-artist"
              to={catalogArtistHref(album.artist_mbid)}
            >
              {album.artist_name}
            </Link>
            {album.year ? ` · ${album.year}` : ''} · {t('count.tracks', { count: tracks.length })}
            {totalMs > 0 ? ` · ${formatDuration(Math.floor(totalMs / 1000))}` : ''}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {libraryId !== undefined ? (
              // Альбом уже в библиотеке: играет то, что доступно, как на его экране.
              <PlayAlbumButton albumId={libraryId} />
            ) : first ? (
              <Button
                aria-busy={albumPending || undefined}
                data-testid="catalog-play-album"
                onClick={() => playRemoteApp().playRemote(request(first, true), t)}
              >
                {albumPending ? (
                  <Spinner className="size-4" />
                ) : (
                  <Play aria-hidden className="size-4" fill="currentColor" />
                )}
                {albumPending ? t('play.waitingShort') : t('play.album')}
              </Button>
            ) : null}
            <AddToLibraryButton
              hideOpen
              input={{
                mbid: album.mbid,
                preview: { artistName: album.artist_name, cover: album.cover_url, title: album.title },
                type: 'album',
              }}
              libraryHref={libraryId === undefined ? null : albumHref(libraryId)}
            />
          </div>
        </div>
      </header>
      {tracks.length === 0 ? (
        <EmptyState body={t('catalog.noTracksBody')} title={t('catalog.noTracks')} />
      ) : (
        <ol className="flex flex-col gap-0.5" data-testid="catalog-tracks">
          {tracks.map((tr, i) => {
            const own = byRecording.get(tr.mbid);
            return (
              <li key={`${tr.disc_no}-${tr.position}-${tr.mbid}`}>
                {multiDisc && tr.disc_no !== tracks[i - 1]?.disc_no ? (
                  <p className="text-muted pt-4 pb-1 text-xs font-medium tracking-wide uppercase">
                    {t('album.disc', { n: tr.disc_no })}
                  </p>
                ) : null}
                <div
                  className="hover:bg-card/60 dark:hover:bg-card-dark/60 flex items-center gap-3 rounded-md px-2 py-1.5"
                  data-testid="catalog-track"
                >
                  <RemotePlayRow
                    leading={
                      <span className="text-muted flex size-8 items-center justify-center font-mono text-xs group-hover:invisible group-focus-visible:invisible group-data-[pending]:invisible group-data-[playing]:invisible">
                        {tr.position}
                      </span>
                    }
                    request={request(tr)}
                  >
                    <span className="truncate text-sm font-medium">{tr.title}</span>
                  </RemotePlayRow>
                  {tr.duration_ms ? (
                    <span className="text-muted font-mono text-xs">
                      {formatDuration(Math.floor(tr.duration_ms / 1000))}
                    </span>
                  ) : null}
                  {libraryId !== undefined ? null : (
                    <AddToLibraryButton
                      hideOpen
                      input={{
                        albumMbid: album.mbid,
                        mbid: tr.mbid,
                        preview: { artistName: album.artist_name, cover: album.cover_url, title: tr.title },
                        type: 'track',
                      }}
                      libraryHref={own?.in_library ? albumHref(own.album_id) : null}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

/** Неверный `:mbid` в адресе: то же, что «нет в MusicBrainz», без запроса. */
const invalidQuery: CatalogQuery<never> = {
  data: undefined,
  error: new ApiError(400, 'bad_mbid', 'mbid must be a UUID'),
  retry: () => undefined,
  retrying: false,
};

/** Альбом из MusicBrainz `/search/album/:mbid`: треклист; нажатие на трек — добавить и играть. */
export function CatalogAlbumScreen() {
  const raw = useParams().mbid ?? '';
  const valid = MBID.test(raw);
  const online = useOnline();
  const query = useCatalogAlbum(raw, valid && online);
  const index = useMbidIndex();
  const t = useT();
  return (
    <PageLayout documentTitle={query.data?.album.title ?? t('kind.album')}>
      <BackButton />
      <CatalogGate
        query={valid ? query : invalidQuery}
        skeleton={
          <div className="flex flex-col gap-8">
            <div className="flex items-end gap-6">
              <Skeleton className="size-48 rounded-md" />
              <Skeleton className="h-10 w-64" />
            </div>
            <TrackListSkeleton />
          </div>
        }
      >
        {data => <AlbumBody data={data} index={index} />}
      </CatalogGate>
    </PageLayout>
  );
}
