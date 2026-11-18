import type { SearchResponse } from '@/lib/api/search-types';
import type { TFn, MessageKey } from '@/lib/i18n/messages';
import { normalize, type MbidIndex, type SearchResult } from '@/lib/store/selectors';
import { formatDuration } from '@/lib/utils';
import type { AddRequest } from './add';

export const PALETTE_ARTISTS = 3;
export const PALETTE_ALBUMS = 3;
export const PALETTE_TRACKS = 5;

export type PaletteItem = {
  id: string;
  group: 'actions' | 'local' | 'artist' | 'album' | 'track';
  title: string;
  subtitle: string;
  meta?: string;
  /** Картинка: обложка альбома, `mbid` артиста для аватара или ничего. */
  cover?: string | null;
  avatar?: { mbid: string; name: string };
  /** Enter ведёт сюда (сущность уже в библиотеке). */
  href?: string;
  /** Enter добавляет в библиотеку (результат MusicBrainz, которого в библиотеке ещё нет). */
  add?: AddRequest;
  /** Enter выполняет действие. */
  run?: () => void;
};

export type PaletteAction = { id: string; label: MessageKey; run: () => void };

const artistHref = (id: number) => `/artist/${id}`;
const albumHref = (id: number) => `/album/${id}`;

/** Элементы палитры: сначала своё (библиотека), затем MusicBrainz (только то, чего в библиотеке нет). */
export function buildPaletteItems(args: {
  local: SearchResult;
  remote: SearchResponse | undefined;
  index: MbidIndex;
  actions: readonly PaletteAction[];
  query: string;
  t: TFn;
}): PaletteItem[] {
  const { local, remote, index, actions, query, t } = args;
  const items: PaletteItem[] = [];
  for (const a of local.artists.slice(0, PALETTE_ARTISTS)) {
    items.push({
      avatar: { mbid: a.mbid, name: a.name },
      group: 'local',
      href: artistHref(a.id),
      id: `local-artist-${a.id}`,
      subtitle: t('kind.artist'),
      title: a.name,
    });
  }
  for (const a of local.albums.slice(0, PALETTE_ALBUMS)) {
    items.push({
      cover: a.cover_url,
      group: 'local',
      href: albumHref(a.id),
      id: `local-album-${a.id}`,
      subtitle: `${t('kind.album')} · ${a.artistName}`,
      title: a.title,
    });
  }
  for (const tr of local.tracks.slice(0, PALETTE_TRACKS)) {
    items.push({
      cover: tr.coverUrl,
      group: 'local',
      href: albumHref(tr.album_id),
      id: `local-track-${tr.id}`,
      meta: tr.duration_ms ? formatDuration(Math.floor(tr.duration_ms / 1000)) : undefined,
      subtitle: [t('kind.track'), tr.artistName, tr.albumTitle].filter(Boolean).join(' · '),
      title: tr.title,
    });
  }
  if (remote) {
    for (const a of remote.artists.filter(r => !index.artists.has(r.mbid)).slice(0, PALETTE_ARTISTS)) {
      items.push({
        add: { mbid: a.mbid, preview: { title: a.name }, type: 'artist' },
        avatar: { mbid: a.mbid, name: a.name },
        group: 'artist',
        id: `artist-${a.mbid}`,
        subtitle: [t('kind.artist'), a.disambiguation, a.country].filter(Boolean).join(' · '),
        title: a.name,
      });
    }
    for (const a of remote.albums.filter(r => !index.albums.has(r.mbid)).slice(0, PALETTE_ALBUMS)) {
      items.push({
        add: { mbid: a.mbid, preview: { artistName: a.artist_name, cover: a.cover_url, title: a.title }, type: 'album' },
        cover: a.cover_url,
        group: 'album',
        id: `album-${a.mbid}`,
        subtitle: [t('kind.album'), a.artist_name, a.year].filter(Boolean).join(' · '),
        title: a.title,
      });
    }
    for (const tr of remote.tracks.filter(r => !index.tracks.has(r.mbid)).slice(0, PALETTE_TRACKS)) {
      items.push({
        add: {
          albumMbid: tr.album_mbid,
          mbid: tr.mbid,
          preview: { artistName: tr.artist_name, cover: tr.cover_url, title: tr.title },
          type: 'track',
        },
        cover: tr.cover_url,
        group: 'track',
        id: `track-${tr.mbid}`,
        meta: tr.duration_ms ? formatDuration(Math.floor(tr.duration_ms / 1000)) : undefined,
        subtitle: [t('kind.track'), tr.artist_name, tr.album_title].filter(Boolean).join(' · '),
        title: tr.title,
      });
    }
  }
  const q = normalize(query.trim());
  const matched: PaletteItem[] = actions
    .filter(a => !q || normalize(t(a.label)).includes(q))
    .map(a => ({
      group: 'actions',
      id: `action-${a.id}`,
      run: a.run,
      subtitle: '',
      title: t(a.label),
    }));
  // Без запроса действия — единственное содержимое, поэтому они сверху; с запросом уступают результатам.
  return q ? [...items, ...matched] : [...matched, ...items];
}
