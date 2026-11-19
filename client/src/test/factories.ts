import { ApiError } from '@/lib/api/errors';
import type { Album, Artist, Entity, LibraryRows, Playlist, PlaylistTrack, Track } from '@/lib/db/types';

/** Ответ бэкенда с телом ошибки `{ error: { code, message } }`. */
export function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

export const apiError = (status = 500, code = 'internal', message = 'boom') => new ApiError(status, code, message);

let seq = 0;
const nextId = () => ++seq;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (n: number) => new Date(T0 + n * 60_000).toISOString();

/** Сбрасывает счётчик id между тестами. */
export const resetFactories = () => {
  seq = 0;
};

export function makeArtist(over: Partial<Artist> = {}): Artist {
  const id = over.id ?? nextId();
  return { added_at: iso(id), in_library: true, id, mbid: `artist-${id}`, name: `Artist ${id}`, ...over };
}

export function makeAlbum(over: Partial<Album> = {}): Album {
  const id = over.id ?? nextId();
  return {
    added_at: iso(id),
    artist_id: 1,
    cover_url: null,
    id,
    in_library: true,
    mbid: `album-${id}`,
    primary_type: 'Album',
    secondary_types: [],
    title: `Album ${id}`,
    year: 2000 + (id % 20),
    ...over,
  };
}

export function makeTrack(over: Partial<Track> = {}): Track {
  const id = over.id ?? nextId();
  return {
    added_at: iso(id),
    album_id: 1,
    artist_id: 1,
    disc_no: 1,
    duration_ms: 180_000,
    id,
    in_library: true,
    last_played_at: null,
    mbid_recording: `rec-${id}`,
    needs_confirmation: false,
    play_count: 0,
    playback: 'direct',
    position: 1,
    status: 'ready',
    title: `Track ${id}`,
    ...over,
  };
}

export function makePlaylist(over: Partial<Playlist> = {}): Playlist {
  const id = over.id ?? nextId();
  return { created_at: iso(id), id, last_used_at: iso(id), name: `Playlist ${id}`, ...over };
}

export function makePlaylistTrack(over: Partial<PlaylistTrack> = {}): PlaylistTrack {
  const id = over.id ?? nextId();
  return { added_at: iso(id), id, playlist_id: 1, track_id: 1, ...over };
}

/** Библиотека из `artists` артистов по `albumsPerArtist` альбомов по `tracksPerAlbum` треков. Все id уникальны. */
export function makeLibrary({
  artists = 2,
  albumsPerArtist = 2,
  tracksPerAlbum = 3,
}: { artists?: number; albumsPerArtist?: number; tracksPerAlbum?: number } = {}): LibraryRows {
  const rows: LibraryRows = { albums: [], artists: [], playlistTracks: [], playlists: [], tracks: [] };
  let aid = 1;
  let alid = 1;
  let tid = 1;
  for (let a = 0; a < artists; a++) {
    const artist = makeArtist({ added_at: iso(aid), id: aid++ });
    rows.artists.push(artist);
    for (let al = 0; al < albumsPerArtist; al++) {
      const album = makeAlbum({ added_at: iso(alid), artist_id: artist.id, id: alid++ });
      rows.albums.push(album);
      for (let t = 0; t < tracksPerAlbum; t++) {
        rows.tracks.push(
          makeTrack({ added_at: iso(tid), album_id: album.id, artist_id: artist.id, id: tid++, position: t + 1 }),
        );
      }
    }
  }
  return rows;
}

const ORDER: Entity[] = ['artist', 'album', 'track', 'playlist', 'playlist_track'];
const FIELD: Record<Entity, keyof LibraryRows> = {
  album: 'albums',
  artist: 'artists',
  playlist: 'playlists',
  playlist_track: 'playlistTracks',
  track: 'tracks',
};
const SNAP_COUNTS: Record<Entity, string> = {
  album: 'albums',
  artist: 'artists',
  playlist: 'playlists',
  playlist_track: 'playlist_tracks',
  track: 'tracks',
};

type Failure = number | 'network';

/**
 * Фейковый сервер синхронизации по контракту шага 34: хранит строки с txid и надгробия, отдаёт снимок (NDJSON)
 * и дельту. Подключается как `fetch` клиента API. Умеет рвать поток, отвечать `reset`, дробить дельту (`more`).
 */
export class FakeSyncServer {
  epoch = 'fake';
  txid = 1;
  pageSize = 5000;
  /** Размер чанка тела снимка в байтах (0 — одним куском): проверяет сборку строк, разорванных между чанками. */
  chunkSize = 0;
  /** Оборвать снимок после стольких строк (без `end`): `truncate` — тихо закрыть поток, `error` — ошибка чтения. */
  cutSnapshot: { afterLines: number; mode: 'truncate' | 'error' } | null = null;
  /** Отдать неверные `counts` в `end`. */
  corruptCounts = false;
  /** Следующий ответ дельты — `reset: true`. */
  resetNext = false;
  /** Очередь отказов: HTTP-статус или `'network'` (запрос падает) — по одному на запрос. */
  failures: Failure[] = [];
  /** Все запросы, включая отклонённые по `failures`. */
  requests = 0;
  snapshotRequests = 0;
  changesRequests = 0;
  cursorsSeen: string[] = [];
  readonly changeResponses: Record<string, unknown>[] = [];

  private rows = new Map<string, { entity: Entity; row: { id: number }; txid: number }>();
  private tombstones = new Map<string, { entity: Entity; id: number; txid: number }>();

  load(rows: Partial<LibraryRows>): this {
    for (const entity of ORDER) {
      for (const row of (rows[FIELD[entity]] ?? []) as { id: number }[]) this.upsert(entity, row);
    }
    return this;
  }

  upsert(entity: Entity, row: { id: number } & Record<string, unknown>): void {
    const key = `${entity}:${row.id}`;
    this.tombstones.delete(key);
    this.rows.set(key, { entity, row, txid: this.txid++ });
  }

  remove(entity: Entity, id: number): void {
    const key = `${entity}:${id}`;
    this.rows.delete(key);
    this.tombstones.set(key, { entity, id, txid: this.txid++ });
  }

  get cursor(): string {
    return `1.${this.epoch}.${this.txid}`;
  }

  /** Текущая строка сущности (мок бэкенда меняет её и возвращает на место через `upsert`). */
  get(entity: Entity, id: number): ({ id: number } & Record<string, unknown>) | undefined {
    return this.rows.get(`${entity}:${id}`)?.row as ({ id: number } & Record<string, unknown>) | undefined;
  }

  /** Все текущие строки сущности. */
  all(entity: Entity): ({ id: number } & Record<string, unknown>)[] {
    return [...this.rows.values()]
      .filter(r => r.entity === entity)
      .map(r => r.row as { id: number } & Record<string, unknown>);
  }

  count(entity: Entity): number {
    return [...this.rows.values()].filter(r => r.entity === entity).length;
  }

  fetch = async (input: Request | string | URL): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input);
    const url = new URL(req.url);
    this.requests++;
    const failure = this.failures.shift();
    if (failure === 'network') throw new TypeError('Failed to fetch');
    if (failure !== undefined) return errorResponse(failure, 'unavailable', 'try later');

    if (url.pathname === '/api/sync/snapshot') return this.snapshot();
    if (url.pathname === '/api/sync/changes') return this.changes(url.searchParams.get('cursor'));
    return errorResponse(404, 'not_found', url.pathname);
  };

  private snapshot(): Response {
    this.snapshotRequests++;
    const lines: string[] = [JSON.stringify({ cursor: this.cursor, schema: 2, type: 'begin' })];
    const counts: Record<string, number> = {};
    for (const entity of ORDER) {
      const rows = [...this.rows.values()].filter(r => r.entity === entity).sort((a, b) => a.row.id - b.row.id);
      counts[SNAP_COUNTS[entity]] = rows.length + (this.corruptCounts ? 1 : 0);
      for (const r of rows) lines.push(JSON.stringify({ row: r.row, type: entity }));
    }
    lines.push(JSON.stringify({ counts, type: 'end' }));

    const cut = this.cutSnapshot;
    const sent = cut ? lines.slice(0, cut.afterLines) : lines;
    const bytes = new TextEncoder().encode(sent.map(l => `${l}\n`).join(''));
    const size = this.chunkSize > 0 ? this.chunkSize : bytes.length || 1;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length) {
          controller.enqueue(bytes.slice(offset, offset + size));
          offset += size;
        } else if (cut?.mode === 'error') controller.error(new TypeError('network error'));
        else controller.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
  }

  private changes(cursor: string | null): Response {
    this.changesRequests++;
    if (!cursor) return errorResponse(400, 'invalid_cursor', 'cursor is required');
    this.cursorsSeen.push(cursor);
    const empty = { albums: [], artists: [], deleted: [], playlist_tracks: [], playlists: [], tracks: [] };
    const parts = cursor.split('.');
    if (this.resetNext || parts[1] !== this.epoch || parts[0] !== '1') {
      this.resetNext = false;
      return this.json({ ...empty, cursor: '', more: false, reset: true });
    }
    const from = Number(parts[2]);
    type Item = { txid: number; entity: Entity; id: number; row?: { id: number } };
    const items: Item[] = [
      ...[...this.rows.values()].filter(r => r.txid >= from).map(r => ({ ...r, id: r.row.id })),
      ...[...this.tombstones.values()].filter(t => t.txid >= from && !this.rows.has(`${t.entity}:${t.id}`)),
    ].sort((a, b) => a.txid - b.txid);
    const page = items.slice(0, this.pageSize);
    const more = items.length > page.length;
    const out: Record<string, unknown[]> = { ...empty };
    for (const it of page) {
      if (it.row) {
        const key = {
          album: 'albums',
          artist: 'artists',
          playlist: 'playlists',
          playlist_track: 'playlist_tracks',
          track: 'tracks',
        }[it.entity];
        out[key]?.push(it.row);
      } else out.deleted?.push({ entity: it.entity, id: it.id });
    }
    const last = page[page.length - 1];
    return this.json({
      ...out,
      cursor: more && last ? `1.${this.epoch}.${last.txid}` : this.cursor,
      more,
      reset: false,
    });
  }

  private json(body: Record<string, unknown>): Response {
    this.changeResponses.push(body);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }
}

/** Небольшая библиотека для мока бэкенда: 3 артиста, 8 альбомов, 80 треков, 2 плейлиста. */
export function makeSmallLibrary(): LibraryRows {
  resetFactories();
  const rows: LibraryRows = { albums: [], artists: [], playlistTracks: [], playlists: [], tracks: [] };
  const albumsOf = [3, 3, 2];
  let alid = 1;
  let tid = 1;
  albumsOf.forEach((count, a) => {
    const artist = makeArtist({ added_at: iso(a + 1), id: a + 1 });
    rows.artists.push(artist);
    for (let al = 0; al < count; al++) {
      const album = makeAlbum({ added_at: iso(alid), artist_id: artist.id, id: alid++ });
      rows.albums.push(album);
      for (let t = 0; t < 10; t++) {
        rows.tracks.push(
          makeTrack({ added_at: iso(tid), album_id: album.id, artist_id: artist.id, id: tid++, position: t + 1 }),
        );
      }
    }
  });
  rows.playlists.push(makePlaylist({ id: 1, name: 'Дорога' }), makePlaylist({ id: 2, name: 'Фокус' }));
  rows.playlistTracks.push(
    makePlaylistTrack({ id: 1, playlist_id: 1, track_id: 1 }),
    makePlaylistTrack({ id: 2, playlist_id: 1, track_id: 12 }),
    makePlaylistTrack({ id: 3, playlist_id: 2, track_id: 25 }),
  );
  return rows;
}

/**
 * Большая библиотека для проверки скорости и виртуализации: `albums` альбомов поровну между `artists` артистами,
 * `tracks` треков поровну между альбомами. Статусы чередуются, `added_at` растёт с id.
 */
export function makeBigLibrary({
  artists,
  albums,
  tracks,
}: {
  artists: number;
  albums: number;
  tracks: number;
}): LibraryRows {
  resetFactories();
  const rows: LibraryRows = { albums: [], artists: [], playlistTracks: [], playlists: [], tracks: [] };
  const statuses = ['ready', 'found', 'adding', 'not_found'] as const;
  for (let a = 1; a <= artists; a++) rows.artists.push(makeArtist({ added_at: iso(a), id: a, name: `Artist ${a}` }));
  for (let al = 1; al <= albums; al++) {
    rows.albums.push(
      makeAlbum({ added_at: iso(al), artist_id: ((al - 1) % artists) + 1, id: al, title: `Album ${al}` }),
    );
  }
  for (let t = 1; t <= tracks; t++) {
    const albumId = ((t - 1) % albums) + 1;
    const album = rows.albums[albumId - 1];
    rows.tracks.push(
      makeTrack({
        added_at: iso(t),
        album_id: albumId,
        artist_id: album?.artist_id ?? 1,
        id: t,
        position: Math.floor((t - 1) / albums) + 1,
        status: statuses[t % statuses.length],
        title: `Track ${t}`,
      }),
    );
  }
  return rows;
}
