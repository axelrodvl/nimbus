import { Link, useParams } from 'react-router';
import { PageLayout } from '@/components/page-layout';
import { TRACK_ROW_HEIGHT } from '@/components/library/track-row';
import { OfflineControl } from '@/components/offline/subject-control';
import { DeletePlaylistButton } from '@/components/playlists/delete-playlist-button';
import { PlaylistCover } from '@/components/playlists/playlist-cover';
import { PlayableTrackRow, PlayTracksButton } from '@/components/player/play-buttons';
import { EmptyState } from '@/components/ui/empty-state';
import { VirtualList } from '@/components/ui/virtual-list';
import { parsePlaylistRef, type PlaylistRef } from '@/lib/api/playlists';
import { useT } from '@/lib/i18n/provider';
import { favoritesSubject, type OfflineSubject } from '@/lib/offline/actions';
import { useTracksOffline } from '@/lib/offline/hooks';
import { useFavorites, usePlaylistCard, usePlaylistTracks } from '@/lib/store/hooks';
import type { TrackView } from '@/lib/store/selectors';
import { formatLongDuration } from '@/lib/utils';
import { TrackListSkeleton } from './library/skeletons';
import { ItemNotFound, useEntityState } from './library/entity-gate';

function useRefTracks(ref: PlaylistRef | null): TrackView[] {
  const favorites = useFavorites();
  const entries = usePlaylistTracks(typeof ref === 'number' ? ref : -1);
  return ref === 'favorites' ? favorites : entries.map(e => e.track);
}

/** Плейлист `/playlist/:id` (`:id` — число или `favorites`): шапка, «Слушать», виртуальный список, удаление. */
export function PlaylistScreen() {
  const t = useT();
  const ref = parsePlaylistRef(useParams().id);
  const card = usePlaylistCard(ref ?? -1);
  const tracks = useRefTracks(ref);
  const state = useEntityState(card !== undefined);
  const offlineSummary = useTracksOffline(tracks.map(tr => tr.id));

  if (ref === null) return <ItemNotFound />;
  if (state === 'loading') {
    return (
      <div className="px-5 pt-[34px] pb-6 sm:pt-6" data-testid="screen-skeleton">
        <TrackListSkeleton />
      </div>
    );
  }
  if (state === 'missing' || !card) return <ItemNotFound />;

  const favorites = card.kind === 'favorites';
  const name = favorites ? t('playlist.favorites') : card.name;
  const queueIds = tracks.map(tr => tr.id);
  const subject: OfflineSubject =
    favorites || typeof card.id !== 'number'
      ? favoritesSubject(name, queueIds)
      : { id: card.id, kind: 'playlist', title: name, trackIds: queueIds };
  return (
    <PageLayout documentTitle={name}>
      <header className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <PlaylistCover
          alt={name}
          card={card}
          className="size-48 self-center shadow-2xl sm:self-auto"
          priority
          thumb={500}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <span className="text-muted text-xs font-medium tracking-wide uppercase">{t('meta.playlist')}</span>
          <h1 className="text-4xl font-bold tracking-tight" data-testid="playlist-title">
            {name}
          </h1>
          <p className="text-muted text-sm" data-testid="playlist-meta">
            {favorites ? `${t('playlist.favoritesHint')} · ` : ''}
            {t('count.tracks', { count: tracks.length })}
            {card.durationMs > 0 ? ` · ${formatLongDuration(card.durationMs)}` : ''}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <PlayTracksButton label={t('play.playlist')} tracks={tracks} />
            {tracks.length > 0 || offlineSummary.state.kind !== 'none' ? (
              <OfflineControl subject={subject} summary={offlineSummary} />
            ) : null}
            {favorites || typeof card.id !== 'number' ? null : <DeletePlaylistButton id={card.id} name={card.name} />}
          </div>
        </div>
      </header>
      {tracks.length === 0 ? (
        <EmptyState title={favorites ? t('playlist.favoritesEmpty') : t('playlist.empty')}>
          <Link className="text-accent-fg underline" to="/library/tracks">
            {t('nav.library')}
          </Link>
        </EmptyState>
      ) : (
        <VirtualList
          count={tracks.length}
          data-testid="playlist-tracks"
          getKey={i => tracks[i]?.id ?? i}
          renderRow={i =>
            tracks[i] ? (
              <PlayableTrackRow
                id={tracks[i].id}
                playlistId={favorites || typeof card.id !== 'number' ? undefined : card.id}
                queueIds={queueIds}
              />
            ) : null
          }
          rowHeight={TRACK_ROW_HEIGHT}
        />
      )}
    </PageLayout>
  );
}
