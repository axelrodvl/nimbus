/** Ключи TanStack Query для источников (серверные данные с коротким сроком жизни, в IndexedDB не кладутся). */
export const albumTorrentsKey = (albumId: number) => ['album-torrents', albumId] as const;
export const trackSourcesKey = (trackId: number) => ['track-sources', trackId] as const;
export const torrentFilesKey = (torrentId: number) => ['torrent-files', torrentId] as const;

/** Данные источников устаревают быстро: проверка раздач идёт в фоне. */
export const SOURCES_STALE_MS = 30_000;
/** Серия событий одного альбома — один запрос. */
export const SOURCES_REFRESH_DEBOUNCE_MS = 1000;
