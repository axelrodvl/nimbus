import type { AlbumResult, ArtistResult, SearchResponse } from '@/lib/api/search-types';
import type { TFn } from '@/lib/i18n/messages';
import { albumTypeLabel } from '@/lib/library/status';

export const artistHref = (id: number) => `/artist/${id}`;
export const albumHref = (id: number) => `/album/${id}`;

export function albumSubtitle(a: AlbumResult, t: TFn): string {
  return [a.artist_name, a.year ? String(a.year) : null, albumTypeLabel(a.primary_type, t)].filter(Boolean).join(' · ');
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Запрос = название трека («Nothing Else Matters») → лучший артист — исполнитель топового трека, а не случайный
 * артист с похожим именем. Если имя артиста совпало с запросом — он и лучший.
 */
export function pickBestArtist(data: SearchResponse): ArtistResult | undefined {
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

/**
 * Экраны каталога MusicBrainz: сущность может быть ещё не в библиотеке. Артист из поиска всегда открывается в
 * каталоге — в библиотеке у него может быть лишь один добавленный трек, а нужна вся дискография.
 */
export const catalogArtistHref = (mbid: string) => `/search/artist/${mbid}`;
export const catalogAlbumHref = (mbid: string) => `/search/album/${mbid}`;

/** Альбом: в библиотеке — её экран, иначе — каталог. */
export const albumLink = (mbid: string, index: { albums: ReadonlyMap<string, number> }): string => {
  const id = index.albums.get(mbid);
  return id === undefined ? catalogAlbumHref(mbid) : albumHref(id);
};
