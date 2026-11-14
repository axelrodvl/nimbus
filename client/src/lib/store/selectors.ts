import type { Schemas } from '@/lib/api/client';
import type { Album, Artist, PlaylistTrack, Track } from '@/lib/db/types';
import type { LibraryState } from './library';

export type TrackStatus = Schemas['TrackStatus'];

export type StatusCounts = Record<TrackStatus, number>;
export type ArtistView = Artist & { albumCount: number; trackCount: number };
export type AlbumView = Album & { artistName: string; trackCount: number; statusCounts: StatusCounts };
export type TrackView = Track & { albumTitle: string; artistName: string; coverUrl: string | null };
export type PlaylistEntry = { id: number; entry: PlaylistTrack; track: TrackView };
export type SearchResult = { artists: ArtistView[]; albums: AlbumView[]; tracks: TrackView[] };

/** Сколько треков показывает динамический плейлист «Избранное» (как на сервере). */
export const FAVORITES_LIMIT = 100;

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY);

/** Нормализация для поиска: регистр, диакритика, «ё» → «е». */
export function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е');
}

function sortDesc<T>(items: T[], key: (item: T) => number, id: (item: T) => number): T[] {
  // Декорирование: даты разбираются один раз, а не на каждом сравнении.
  return items
    .map(item => ({ id: id(item), item, k: key(item) }))
    .sort((a, b) => (b.k === a.k ? b.id - a.id : b.k > a.k ? 1 : -1))
    .map(x => x.item);
}

const statusKey = (statuses?: readonly TrackStatus[]) => (statuses?.length ? [...statuses].sort().join(',') : '');

type Deps = readonly unknown[];
const same = (a: Deps, b: Deps) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Кэш на ключ: результат переиспользуется (та же ссылка), пока зависимости не изменились. */
function memoByKey<K, R>() {
  const cache = new Map<K, { deps: Deps; value: R }>();
  return (key: K, deps: Deps, compute: () => R): R => {
    const hit = cache.get(key);
    if (hit && same(hit.deps, deps)) return hit.value;
    const value = compute();
    cache.set(key, { deps, value });
    return value;
  };
}

/**
 * Производные данные, которые раньше считал сервер. Селекторы чистые: принимают состояние и возвращают
 * мемоизированные значения (та же ссылка при неизменных входных данных — безопасно для `useSyncExternalStore`).
 * У каждого вызова `createSelectors()` свои кэши.
 */
export function createSelectors() {
  const trackViews = memoByKey<number, TrackView>();
  const albumViews = memoByKey<number, AlbumView>();
  const artistViews = memoByKey<number, ArtistView>();
  const lists = memoByKey<string, unknown>();

  function trackView(s: LibraryState, id: number): TrackView | undefined {
    const t = s.tracks.get(id);
    if (!t) return undefined;
    const album = s.albums.get(t.album_id);
    const artist = s.artists.get(t.artist_id);
    return trackViews(id, [t, album, artist], () => ({
      ...t,
      albumTitle: album?.title ?? '',
      artistName: artist?.name ?? '',
      coverUrl: album?.cover_url ?? null,
    }));
  }

  function albumView(s: LibraryState, id: number): AlbumView | undefined {
    const a = s.albums.get(id);
    if (!a) return undefined;
    const artist = s.artists.get(a.artist_id);
    const ids = s.tracksByAlbum.get(id);
    // Зависимость — сами строки треков альбома: смена статуса одного трека пересчитывает счётчики.
    const rows = (ids ?? []).map(t => s.tracks.get(t));
    return albumViews(id, [a, artist, ...rows], () => {
      // Как `ALBUM_SELECT` в views.rs: считаются все треки альбома, не только `in_library`.
      const statusCounts: StatusCounts = { adding: 0, found: 0, not_found: 0, ready: 0 };
      for (const t of rows) if (t) statusCounts[t.status] += 1;
      return { ...a, artistName: artist?.name ?? '', statusCounts, trackCount: rows.length };
    });
  }

  const inLibraryTracks = (s: LibraryState, ids: number[] | undefined) =>
    (ids ?? []).map(id => s.tracks.get(id)).filter((t): t is Track => !!t?.in_library);

  /** Альбом библиотеки: добавлен целиком или в библиотеке есть хотя бы один его трек. */
  const albumInLibrary = (s: LibraryState, a: Album) =>
    a.in_library || inLibraryTracks(s, s.tracksByAlbum.get(a.id)).length > 0;

  function artistView(s: LibraryState, id: number): ArtistView | undefined {
    const a = s.artists.get(id);
    if (!a) return undefined;
    const albumIds = s.albumsByArtist.get(id) ?? [];
    const deps: unknown[] = [a, s.albums, s.tracks, s.albumsByArtist.get(id), s.tracksByArtist.get(id)];
    for (const albumId of albumIds) deps.push(s.tracksByAlbum.get(albumId));
    return artistViews(id, deps, () => {
      let albumCount = 0;
      const tracks = new Set<number>();
      for (const albumId of albumIds) {
        const album = s.albums.get(albumId);
        if (!album) continue;
        const own = inLibraryTracks(s, s.tracksByAlbum.get(albumId));
        if (album.in_library || own.length > 0) albumCount += 1;
        for (const t of own) tracks.add(t.id);
      }
      for (const t of inLibraryTracks(s, s.tracksByArtist.get(id))) tracks.add(t.id);
      return { ...a, albumCount, trackCount: tracks.size };
    });
  }

  const hasStatus = (s: LibraryState, ids: number[] | undefined, statuses: readonly TrackStatus[]) =>
    inLibraryTracks(s, ids).some(t => statuses.includes(t.status));

  /** Артисты библиотеки (`GET /api/library/artists`): новые сверху. С `statuses` — только имеющие трек с таким статусом. */
  function libraryArtists(s: LibraryState, statuses?: readonly TrackStatus[]): ArtistView[] {
    return lists(`artists:${statusKey(statuses)}`, [s.artists, s.albums, s.tracks, s.albumsByArtist], () => {
      let rows = [...s.artists.values()].filter(a => a.in_library);
      if (statuses?.length) {
        rows = rows.filter(
          a =>
            hasStatus(s, s.tracksByArtist.get(a.id), statuses) ||
            (s.albumsByArtist.get(a.id) ?? []).some(al => hasStatus(s, s.tracksByAlbum.get(al), statuses)),
        );
      }
      return sortDesc(
        rows,
        a => ms(a.added_at),
        a => a.id,
      )
        .map(a => artistView(s, a.id))
        .filter((v): v is ArtistView => !!v);
    }) as ArtistView[];
  }

  /**
   * Альбомы библиотеки (`GET /api/library/albums`): сортировка по самой поздней дате добавления альбома
   * или его трека библиотеки, новые сверху.
   */
  function libraryAlbums(s: LibraryState, statuses?: readonly TrackStatus[]): AlbumView[] {
    return lists(`albums:${statusKey(statuses)}`, [s.artists, s.albums, s.tracks], () => {
      const rows: { album: Album; at: number }[] = [];
      for (const album of s.albums.values()) {
        const own = inLibraryTracks(s, s.tracksByAlbum.get(album.id));
        if (!album.in_library && own.length === 0) continue;
        if (statuses?.length && !own.some(t => statuses.includes(t.status))) continue;
        rows.push({ album, at: Math.max(ms(album.added_at), ...own.map(t => ms(t.added_at))) });
      }
      return sortDesc(
        rows,
        r => r.at,
        r => r.album.id,
      )
        .map(r => albumView(s, r.album.id))
        .filter((v): v is AlbumView => !!v);
    }) as AlbumView[];
  }

  /** Треки библиотеки (`GET /api/library/tracks`): новые сверху, опционально по статусам. */
  function libraryTracks(s: LibraryState, statuses?: readonly TrackStatus[]): TrackView[] {
    return lists(`tracks:${statusKey(statuses)}`, [s.tracks, s.albums, s.artists], () => {
      const rows: Track[] = [];
      for (const t of s.tracks.values()) {
        if (t.in_library && (!statuses?.length || statuses.includes(t.status))) rows.push(t);
      }
      return sortDesc(
        rows,
        t => ms(t.added_at),
        t => t.id,
      )
        .map(t => trackView(s, t.id))
        .filter((v): v is TrackView => !!v);
    }) as TrackView[];
  }

  /** Альбомы артиста по году выхода (без года — в конце). `libraryOnly` — как список страницы библиотеки. */
  function artistAlbums(s: LibraryState, artistId: number, libraryOnly = false): AlbumView[] {
    return lists(
      `artistAlbums:${artistId}:${libraryOnly}`,
      [s.albums, s.tracks, s.artists, s.albumsByArtist.get(artistId)],
      () => {
        const rows = (s.albumsByArtist.get(artistId) ?? [])
          .map(id => s.albums.get(id))
          .filter((a): a is Album => !!a && (!libraryOnly || albumInLibrary(s, a)));
        rows.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.id - b.id);
        return rows.map(a => albumView(s, a.id)).filter((v): v is AlbumView => !!v);
      },
    ) as AlbumView[];
  }

  /** Все треки альбома по `disc_no`, `position`. */
  function albumTracks(s: LibraryState, albumId: number): TrackView[] {
    return lists(`albumTracks:${albumId}`, [s.tracks, s.albums, s.artists, s.tracksByAlbum.get(albumId)], () => {
      const rows = (s.tracksByAlbum.get(albumId) ?? []).map(id => s.tracks.get(id)).filter((t): t is Track => !!t);
      rows.sort((a, b) => a.disc_no - b.disc_no || a.position - b.position || a.id - b.id);
      return rows.map(t => trackView(s, t.id)).filter((v): v is TrackView => !!v);
    }) as TrackView[];
  }

  /** Треки плейлиста в порядке добавления (по id строки). Строки без трека в store пропускаются. */
  function playlistTracks(s: LibraryState, playlistId: number): PlaylistEntry[] {
    return lists(
      `playlist:${playlistId}`,
      [s.playlistTracks, s.tracks, s.albums, s.artists, s.tracksByPlaylist.get(playlistId)],
      () => {
        const out: PlaylistEntry[] = [];
        const ids = [...(s.tracksByPlaylist.get(playlistId) ?? [])].sort((a, b) => a - b);
        for (const id of ids) {
          const entry = s.playlistTracks.get(id);
          const track = entry && trackView(s, entry.track_id);
          if (entry && track) out.push({ entry, id, track });
        }
        return out;
      },
    ) as PlaylistEntry[];
  }

  /** Недавно проигранные альбомы: по самому свежему `last_played_at` его треков. */
  function recentlyPlayedAlbums(s: LibraryState, limit: number): AlbumView[] {
    return lists(`recent:${limit}`, [s.tracks, s.albums, s.artists], () => {
      const played = new Map<number, number>();
      for (const t of s.tracks.values()) {
        if (!t.last_played_at) continue;
        played.set(t.album_id, Math.max(played.get(t.album_id) ?? Number.NEGATIVE_INFINITY, ms(t.last_played_at)));
      }
      const rows = [...played].map(([albumId, at]) => ({ albumId, at }));
      return sortDesc(
        rows,
        r => r.at,
        r => r.albumId,
      )
        .slice(0, limit)
        .map(r => albumView(s, r.albumId))
        .filter((v): v is AlbumView => !!v);
    }) as AlbumView[];
  }

  /** «Избранное»: топ-100 по числу прослушиваний, затем по давности (как динамический плейлист на сервере). */
  function favorites(s: LibraryState): TrackView[] {
    return lists('favorites', [s.tracks, s.albums, s.artists], () => {
      const rows = [...s.tracks.values()].filter(t => t.play_count > 0);
      rows.sort((a, b) => b.play_count - a.play_count || ms(b.last_played_at) - ms(a.last_played_at) || a.id - b.id);
      return rows
        .slice(0, FAVORITES_LIMIT)
        .map(t => trackView(s, t.id))
        .filter((v): v is TrackView => !!v);
    }) as TrackView[];
  }

  /** Поиск по подстроке среди артистов, альбомов и треков библиотеки (регистр, диакритика, «ё/е» не важны). */
  function searchLocal(s: LibraryState, query: string, limit: number): SearchResult {
    const q = normalize(query.trim());
    return lists(`search:${q}:${limit}`, [s.artists, s.albums, s.tracks], () => {
      const empty: SearchResult = { albums: [], artists: [], tracks: [] };
      if (!q) return empty;
      // Совпадения с начала названия — выше, остальные — в порядке списка библиотеки.
      const pick = <V extends { id: number }>(items: V[], name: (v: V) => string): V[] => {
        const starts: V[] = [];
        const rest: V[] = [];
        for (const v of items) {
          const n = normalize(name(v));
          if (n.startsWith(q)) starts.push(v);
          else if (n.includes(q)) rest.push(v);
        }
        return [...starts, ...rest].slice(0, limit);
      };
      return {
        albums: pick(libraryAlbums(s), a => a.title),
        artists: pick(libraryArtists(s), a => a.name),
        tracks: pick(libraryTracks(s), t => t.title),
      };
    }) as SearchResult;
  }

  return {
    albumTracks,
    albumView,
    artistAlbums,
    artistView,
    favorites,
    libraryAlbums,
    libraryArtists,
    libraryTracks,
    playlistTracks,
    recentlyPlayedAlbums,
    searchLocal,
    trackView,
  };
}

export type Selectors = ReturnType<typeof createSelectors>;
