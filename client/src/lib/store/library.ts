import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Album, Artist, Batch, Entity, LibraryData, Playlist, PlaylistTrack, Track } from '@/lib/db/types';

export type Index = Map<number, number[]>;

/**
 * Начало диапазона id для строк, созданных оптимистично до ответа сервера (например, трек, только что добавленный
 * в плейлист). Настоящие id намного меньше, поэтому такие строки идут в конце списка; когда дельта приносит
 * настоящую строку для той же пары, временная удаляется (`applyBatch`).
 */
export const TEMP_ID_BASE = 2 ** 52;

/**
 * Таблица строк по id с интерфейсом `Map` для чтения. Новая ссылка создаётся на каждое изменение (по ней
 * работают селекторы), но данные под ней общие и меняются на месте: копировать `Map` из 60 000 строк
 * на каждую пачку из 100 строк слишком дорого (≈ 15 мс против < 1 мс). Читать нужно всегда из актуального
 * состояния store, а не хранить старую таблицу «как снимок».
 */
export class Table<V> implements Iterable<[number, V]> {
  /** Общий словарь; не изменять снаружи `library.ts`. */
  readonly raw: Map<number, V>;
  constructor(raw: Map<number, V> = new Map()) {
    this.raw = raw;
  }
  get size() {
    return this.raw.size;
  }
  get(id: number) {
    return this.raw.get(id);
  }
  has(id: number) {
    return this.raw.has(id);
  }
  keys() {
    return this.raw.keys();
  }
  values() {
    return this.raw.values();
  }
  entries() {
    return this.raw.entries();
  }
  [Symbol.iterator]() {
    return this.raw.entries();
  }
}

export type LibraryState = {
  artists: Table<Artist>;
  albums: Table<Album>;
  tracks: Table<Track>;
  playlists: Table<Playlist>;
  playlistTracks: Table<PlaylistTrack>;
  /** artist_id → id альбомов. */
  albumsByArtist: Index;
  /** album_id → id треков. */
  tracksByAlbum: Index;
  /** artist_id трека → id треков (исполнитель трека может отличаться от исполнителя альбома). */
  tracksByArtist: Index;
  /** playlist_id → id строк `playlist_tracks` (порядок вставки; порядок воспроизведения — по возрастанию id). */
  tracksByPlaylist: Index;
  /** Растёт на каждое применение; по нему мемоизируются производные данные. */
  version: number;
  /** Артисты, альбомы, плейлисты прочитаны из локальной базы: экраны, которым треки не нужны, могут рисовать. */
  hydrated: boolean;
  /** Треки тоже прочитаны (фаза 2): списки по статусам, строки альбомов, «Недавно слушали», плеер, офлайн. */
  tracksHydrated: boolean;
};

export type TrackPatch = Partial<Omit<Track, 'id' | 'album_id' | 'artist_id'>>;

export type LibraryActions = {
  /**
   * Первичная загрузка из IndexedDB: экраны могут рисовать, пока идёт синхронизация. Без `tracks` — только фаза 1
   * (`tracksHydrated` остаётся `false` до `hydrateTracks`).
   */
  hydrate(data: Omit<LibraryData, 'meta' | 'tracks'> & { tracks?: Track[] }): void;
  /**
   * Фаза 2: добавить треки, прочитанные из базы. То, что дельта успела принести (и удалить) между фазами, новее
   * прочитанного — строки из базы это не перезаписывают; повторный вызов и вызов после `replaceAll` ничего не делают.
   */
  hydrateTracks(rows: Track[]): void;
  /** Применить пачку (upsert, затем удаления): одно обновление состояния. */
  applyBatch(batch: Batch): void;
  /** Заменить всё принятым снимком. */
  replaceAll(data: Omit<LibraryData, 'meta'>): void;
  /** Мгновенное обновление трека (событие `track.status`), не дожидаясь дельты. */
  patchTrack(id: number, partial: TrackPatch): void;
  /** Пачка патчей треков — одно обновление состояния; отсутствующие id пропускаются. */
  patchTracks(patches: ReadonlyMap<number, TrackPatch>): void;
  reset(): void;
};

export type LibraryStore = StoreApi<LibraryState & LibraryActions>;

/** Накапливает изменения таблицы; неизменённая таблица возвращается как есть (та же ссылка). */
class TableDraft<V> {
  private touched = false;
  constructor(private readonly base: Table<V>) {}
  get(id: number): V | undefined {
    return this.base.raw.get(id);
  }
  set(id: number, value: V) {
    this.base.raw.set(id, value);
    this.touched = true;
  }
  delete(id: number) {
    if (this.base.raw.delete(id)) this.touched = true;
  }
  get changed() {
    return this.touched;
  }
  result() {
    return this.touched ? new Table(this.base.raw) : this.base;
  }
}

/** Индекс «ключ → список id»: копируется карта и только затронутые массивы. */
class IndexDraft {
  private next: Index | null = null;
  private readonly fresh = new Set<number>();
  constructor(private readonly base: Index) {}

  private own(key: number): number[] {
    const map = (this.next ??= new Map(this.base));
    let arr = map.get(key);
    if (!arr || !this.fresh.has(key)) {
      arr = arr ? arr.slice() : [];
      map.set(key, arr);
      this.fresh.add(key);
    }
    return arr;
  }
  add(key: number, id: number) {
    this.own(key).push(id);
  }
  remove(key: number, id: number) {
    const current = (this.next ?? this.base).get(key);
    if (!current?.includes(id)) return;
    const arr = this.own(key);
    arr.splice(arr.indexOf(id), 1);
    if (arr.length === 0) {
      this.next?.delete(key);
      this.fresh.delete(key);
    }
  }
  result() {
    return this.next ?? this.base;
  }
}

const initial = (): LibraryState => ({
  albums: new Table(),
  albumsByArtist: new Map(),
  artists: new Table(),
  hydrated: false,
  tracksHydrated: false,
  playlistTracks: new Table(),
  playlists: new Table(),
  tracks: new Table(),
  tracksByAlbum: new Map(),
  tracksByArtist: new Map(),
  tracksByPlaylist: new Map(),
  version: 0,
});

const toTable = <T extends { id: number }>(rows: T[]) => new Table(new Map(rows.map(r => [r.id, r])));

function buildIndex<T extends { id: number }>(rows: T[], key: (r: T) => number): Index {
  const index: Index = new Map();
  for (const row of rows) {
    const k = key(row);
    const arr = index.get(k);
    if (arr) arr.push(row.id);
    else index.set(k, [row.id]);
  }
  return index;
}

function build(
  data: Omit<LibraryData, 'meta' | 'tracks'> & { tracks?: Track[] },
): Omit<LibraryState, 'version' | 'hydrated' | 'tracksHydrated'> {
  const tracks = data.tracks ?? [];
  return {
    albums: toTable(data.albums),
    albumsByArtist: buildIndex(data.albums, a => a.artist_id),
    artists: toTable(data.artists),
    playlistTracks: toTable(data.playlistTracks),
    playlists: toTable(data.playlists),
    tracks: toTable(tracks),
    tracksByAlbum: buildIndex(tracks, t => t.album_id),
    tracksByArtist: buildIndex(tracks, t => t.artist_id),
    tracksByPlaylist: buildIndex(data.playlistTracks, p => p.playlist_id),
  };
}

function applyBatch(s: LibraryState, batch: Batch): Partial<LibraryState> | null {
  const artists = new TableDraft(s.artists);
  const albums = new TableDraft(s.albums);
  const tracks = new TableDraft(s.tracks);
  const playlists = new TableDraft(s.playlists);
  const playlistTracks = new TableDraft(s.playlistTracks);
  const albumsByArtist = new IndexDraft(s.albumsByArtist);
  const tracksByAlbum = new IndexDraft(s.tracksByAlbum);
  const tracksByArtist = new IndexDraft(s.tracksByArtist);
  const tracksByPlaylist = new IndexDraft(s.tracksByPlaylist);

  for (const row of batch.artists ?? []) artists.set(row.id, row);
  for (const row of batch.albums ?? []) {
    const old = albums.get(row.id);
    if (!old || old.artist_id !== row.artist_id) {
      if (old) albumsByArtist.remove(old.artist_id, row.id);
      albumsByArtist.add(row.artist_id, row.id);
    }
    albums.set(row.id, row);
  }
  for (const row of batch.tracks ?? []) {
    const old = tracks.get(row.id);
    // Перемещение трека (сменился альбом/исполнитель) обновляет оба индекса.
    if (!old || old.album_id !== row.album_id) {
      if (old) tracksByAlbum.remove(old.album_id, row.id);
      tracksByAlbum.add(row.album_id, row.id);
    }
    if (!old || old.artist_id !== row.artist_id) {
      if (old) tracksByArtist.remove(old.artist_id, row.id);
      tracksByArtist.add(row.artist_id, row.id);
    }
    tracks.set(row.id, row);
  }
  for (const row of batch.playlists ?? []) playlists.set(row.id, row);
  for (const row of batch.playlistTracks ?? []) {
    if (row.id < TEMP_ID_BASE) {
      // Настоящая строка заменяет временную (оптимистичное добавление) для того же трека плейлиста.
      for (const id of s.tracksByPlaylist.get(row.playlist_id) ?? []) {
        if (id >= TEMP_ID_BASE && playlistTracks.get(id)?.track_id === row.track_id) {
          playlistTracks.delete(id);
          tracksByPlaylist.remove(row.playlist_id, id);
        }
      }
    }
    const old = playlistTracks.get(row.id);
    if (!old || old.playlist_id !== row.playlist_id) {
      if (old) tracksByPlaylist.remove(old.playlist_id, row.id);
      tracksByPlaylist.add(row.playlist_id, row.id);
    }
    playlistTracks.set(row.id, row);
  }

  for (const { entity, id } of batch.deleted ?? []) {
    switch (entity as Entity) {
      case 'artist':
        artists.delete(id);
        break;
      case 'album': {
        const old = albums.get(id);
        if (old) albumsByArtist.remove(old.artist_id, id);
        albums.delete(id);
        break;
      }
      case 'track': {
        const old = tracks.get(id);
        if (old) {
          tracksByAlbum.remove(old.album_id, id);
          tracksByArtist.remove(old.artist_id, id);
        }
        tracks.delete(id);
        break;
      }
      case 'playlist':
        playlists.delete(id);
        break;
      case 'playlist_track': {
        const old = playlistTracks.get(id);
        if (old) tracksByPlaylist.remove(old.playlist_id, id);
        playlistTracks.delete(id);
        break;
      }
    }
  }

  if (![artists, albums, tracks, playlists, playlistTracks].some(d => d.changed)) return null;
  return {
    albums: albums.result(),
    albumsByArtist: albumsByArtist.result(),
    artists: artists.result(),
    playlistTracks: playlistTracks.result(),
    playlists: playlists.result(),
    tracks: tracks.result(),
    tracksByAlbum: tracksByAlbum.result(),
    tracksByArtist: tracksByArtist.result(),
    tracksByPlaylist: tracksByPlaylist.result(),
  };
}

/** Библиотека в памяти. Каждое действие — ровно одно обновление состояния (один рендер). */
export function createLibraryStore(): LibraryStore {
  // Треки, удалённые дельтой до фазы 2: строка из базы (прочитанная раньше удаления) не должна воскреснуть.
  let removedEarly = new Set<number>();
  return createStore<LibraryState & LibraryActions>()((set, get) => ({
    ...initial(),
    applyBatch(batch) {
      if (!get().tracksHydrated) {
        for (const d of batch.deleted ?? []) if (d.entity === 'track') removedEarly.add(d.id);
      }
      const patch = applyBatch(get(), batch);
      if (patch) set(s => ({ ...patch, version: s.version + 1 }));
    },
    hydrate(data) {
      removedEarly = new Set();
      set(s => ({ ...build(data), hydrated: true, tracksHydrated: data.tracks !== undefined, version: s.version + 1 }));
    },
    hydrateTracks(rows) {
      const s = get();
      if (s.tracksHydrated) return;
      const fresh = rows.filter(t => !s.tracks.raw.has(t.id) && !removedEarly.has(t.id));
      removedEarly = new Set();
      const tracks = new TableDraft(s.tracks);
      const byAlbum = new IndexDraft(s.tracksByAlbum);
      const byArtist = new IndexDraft(s.tracksByArtist);
      for (const t of fresh) {
        tracks.set(t.id, t);
        byAlbum.add(t.album_id, t.id);
        byArtist.add(t.artist_id, t.id);
      }
      set(st => ({
        tracks: new Table(tracks.result().raw),
        tracksByAlbum: byAlbum.result(),
        tracksByArtist: byArtist.result(),
        tracksHydrated: true,
        version: st.version + 1,
      }));
    },
    patchTrack(id, partial) {
      get().patchTracks(new Map([[id, partial]]));
    },
    patchTracks(patches) {
      const { tracks } = get();
      let changed = false; // треки, которых ещё нет (фаза 2 впереди), пропускаются: их догонит дельта
      for (const [id, partial] of patches) {
        const old = tracks.get(id);
        if (!old) continue;
        tracks.raw.set(id, { ...old, ...partial });
        changed = true;
      }
      if (changed) set(s => ({ tracks: new Table(s.tracks.raw), version: s.version + 1 }));
    },
    replaceAll(data) {
      removedEarly = new Set();
      set(s => ({ ...build(data), hydrated: true, tracksHydrated: true, version: s.version + 1 }));
    },
    reset() {
      set(s => ({ ...initial(), version: s.version + 1 }));
    },
  }));
}
