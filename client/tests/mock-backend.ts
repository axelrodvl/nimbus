// Мок бэкенда для Playwright (запускается под bun). Состояние живёт в памяти процесса; тесты идут последовательно
// и сбрасывают его через `POST /__test/reset`. Данные синхронизации отдаёт тот же `FakeSyncServer`, что и unit-тесты.
import {
  FakeSyncServer,
  makeAlbum,
  makeArtist,
  makeBigLibrary,
  makeSmallLibrary,
  makeTrack,
} from '../src/test/factories';
import searchFixture from './fixtures/search-radiohead.json';
import { createAcquisitionMock } from './mock-acquisition';

const PORT = Number(process.env.MOCK_BACKEND_PORT ?? 4011);
const TOKEN = 'secret';
const COOKIE = 'nimbus_token';

type Entity = Parameters<FakeSyncServer['upsert']>[0];

type ImportStatus = { attempt: number; max_attempts: number; state: string; error?: string; retry_at?: string };

type Search = { delayMs: number; failStatus: number | null; addDelayMs: number; addFailStatus: number | null };
const NO_SEARCH_FAULTS: Search = { addDelayMs: 0, addFailStatus: null, delayMs: 0, failStatus: null };

type MockTorrent = {
  id: number;
  info_hash: string;
  kind: string;
  leechers: number | null;
  meta_status: string;
  seeders: number | null;
  size_bytes: number | null;
  source: string;
  title: string;
};
type MockSource = {
  id: number;
  torrent: MockTorrent;
  file_index: number;
  path: string;
  size_bytes: number;
  match_score: number;
  is_primary: boolean;
  needs_confirmation: boolean;
};

const PIXEL = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  c => c.charCodeAt(0),
);

const state = {
  authRequired: false,
  /** HTTP-статус, которым отвечают изменяющие запросы плейлистов (`null` — норма). */
  failPlaylists: null as number | null,
  playlistDelayMs: 0,
  extraTorrents: new Map<number, MockTorrent[]>(),
  /** Раздача, выбранная для альбома вручную (`POST …/torrents/{id}/use`). */
  usedTorrent: new Map<number, number>(),
  trackSources: new Map<number, MockSource[]>(),
  faults: { ...NO_SEARCH_FAULTS },
  failDelete: false,
  imports: new Map<number, ImportStatus>(),
  blockWs: false,
  log: [] as string[],
  server: new FakeSyncServer().load(makeSmallLibrary()),
  snapshotDelayMs: 0,
  streamDelayMs: new Map<number, number>(),
  /** Обрыв ответа потока: id трека → сколько байт отдать до обрыва (срабатывает один раз). */
  streamCut: new Map<number, number>(),
  prefetchNext: true,
  settings: defaultSettings(),
  /** HTTP-статус, которым отвечает `PUT /api/settings` (`null` — норма). */
  settingsFault: null as number | null,
  providerTestOk: true,
};
const clients = new Set<MockWebSocket>();

// ---------------------------------------------------------------- звук: 5-секундный WAV (8 кГц, моно, 16 бит)
const RATE = 8000;
const SECONDS = 5;
const WAV = (() => {
  const samples = RATE * SECONDS;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 8000), 44 + i * 2);
  return buf;
})();

/** WAV с начала `startSec`: для перекодируемых треков поток без Range, перемотка идёт запросом `?t=`. */
function wavFrom(startSec: number): Buffer {
  const skip = Math.min(Math.floor(startSec * RATE), RATE * SECONDS) * 2;
  const data = WAV.subarray(44 + skip);
  const head = Buffer.from(WAV.subarray(0, 44));
  head.writeUInt32LE(36 + data.length, 4);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Треки, поток которых отдаётся с ошибкой (как настоящий бэкенд): id → [HTTP-статус, код]. */
const STREAM_ERRORS: Record<number, [number, string]> = { 9034: [503, 'ffmpeg_missing'] };

function reset(opts: { authRequired?: boolean; snapshotDelayMs?: number }) {
  state.authRequired = opts.authRequired ?? false;
  state.snapshotDelayMs = opts.snapshotDelayMs ?? 0;
  state.blockWs = false;
  state.failDelete = false;
  state.faults = { ...NO_SEARCH_FAULTS };
  state.streamDelayMs.clear();
  state.streamCut.clear();
  state.prefetchNext = true;
  state.settings = defaultSettings();
  state.settingsFault = null;
  state.providerTestOk = true;
  state.imports.clear();
  acquisition.reset();
  state.failPlaylists = null;
  state.playlistDelayMs = 0;
  state.extraTorrents.clear();
  state.usedTorrent.clear();
  state.trackSources.clear();
  state.log = [];
  state.server = new FakeSyncServer().load(makeSmallLibrary());
  dropClients();
}

function dropClients() {
  for (const ws of clients) ws.close();
  clients.clear();
}

const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });

const cookieOf = (req: Request) =>
  Object.fromEntries(
    (req.headers.get('cookie') ?? '')
      .split(';')
      .map(p => p.trim().split('=') as [string, string])
      .filter(([k]) => k),
  )[COOKIE];

/** Как сервер: убирает из библиотеки сам объект и всё, что в нём лежит. */
function removeFromLibrary(type: 'artist' | 'album', id: number) {
  const off = (entity: Entity, row: { id: number } & Record<string, unknown>) =>
    state.server.upsert(entity, { ...row, in_library: false });
  const current = state.server.get(type, id);
  if (current) off(type, current);
  for (const album of state.server.all('album')) {
    if (type === 'artist' ? album.artist_id === id : album.id === id) off('album', album);
  }
  for (const track of state.server.all('track')) {
    if (type === 'artist' ? track.artist_id === id : track.album_id === id) off('track', track);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const nextId = (entity: Entity) => Math.max(0, ...state.server.all(entity).map(r => r.id)) + 1;
const now = () => new Date().toISOString();

type AddBody = { type: 'artist' | 'album' | 'track'; mbid: string; album_mbid?: string | null };

/** Находит или создаёт артиста с таким `mbid` (создаётся не в библиотеке — как делает сервер для автора альбома). */
function ensureArtist(mbid: string, name: string, inLibrary: boolean) {
  const found = state.server.all('artist').find(a => a.mbid === mbid);
  if (found) {
    if (inLibrary && !found.in_library) state.server.upsert('artist', { ...found, added_at: now(), in_library: true });
    return state.server.get('artist', found.id)!;
  }
  const row = makeArtist({ added_at: now(), id: nextId('artist'), in_library: inLibrary, mbid, name });
  state.server.upsert('artist', row);
  return row;
}

function ensureAlbum(mbid: string, inLibrary: boolean) {
  const found = state.server.all('album').find(a => a.mbid === mbid);
  if (found) return found;
  const hit = searchFixture.albums.find(a => a.mbid === mbid);
  if (!hit) return undefined;
  const artist = ensureArtist(hit.artist_mbid, hit.artist_name, false);
  const album = makeAlbum({
    added_at: now(),
    artist_id: artist.id,
    cover_url: hit.cover_url,
    id: nextId('album'),
    in_library: inLibrary,
    mbid,
    title: hit.title,
    year: hit.year,
  });
  state.server.upsert('album', album);
  return album;
}

/** `POST /api/library`: создаёт сущности из фикстуры поиска; `null` — такого mbid нет. */
function addToLibrary(body: AddBody): { status: number; body: unknown } | null {
  if (body.type === 'artist') {
    const hit = searchFixture.artists.find(a => a.mbid === body.mbid);
    if (!hit) return null;
    const exists = state.server.all('artist').some(a => a.mbid === body.mbid && a.in_library);
    const artist = ensureArtist(hit.mbid, hit.name, true);
    return {
      body: { id: artist.id, status: exists ? 'exists' : 'importing', type: 'artist' },
      status: exists ? 200 : 202,
    };
  }
  if (body.type === 'album') {
    const album = ensureAlbum(body.mbid, true);
    if (!album) return null;
    state.server.upsert('album', { ...album, in_library: true });
    if (!state.server.all('track').some(t => t.album_id === album.id)) {
      for (let position = 1; position <= 3; position++) {
        state.server.upsert(
          'track',
          makeTrack({
            added_at: now(),
            album_id: album.id,
            artist_id: Number(album.artist_id),
            id: nextId('track'),
            position,
            status: 'adding',
            title: `${String(album.title)} · ${position}`,
          }),
        );
      }
    }
    return { body: { id: album.id, status: 'added', type: 'album' }, status: 201 };
  }
  const hit = searchFixture.tracks.find(t => t.mbid === body.mbid);
  if (!hit || !hit.album_mbid) return null;
  const album = ensureAlbum(hit.album_mbid, false);
  if (!album) return null;
  const track = makeTrack({
    added_at: now(),
    album_id: album.id,
    artist_id: Number(album.artist_id),
    id: nextId('track'),
    mbid_recording: hit.mbid,
    status: 'adding',
    title: hit.title,
  });
  state.server.upsert('track', track);
  return { body: { id: track.id, status: 'added', type: 'track' }, status: 201 };
}

/** `POST /api/play`: как настоящий сервер — метаданные сохраняются, треки ищутся (`adding`), в библиотеку не попадают. */
function playRoute(body: { type: string; mbid: string; album_mbid?: string | null }): unknown {
  const albumMbid =
    body.type === 'album' ? body.mbid : (body.album_mbid ?? searchFixture.tracks.find(t => t.mbid === body.mbid)?.album_mbid);
  if (!albumMbid) return null;
  const album = ensureAlbum(albumMbid, false);
  if (!album) return null;
  const hits = searchFixture.tracks.filter(t => t.album_mbid === albumMbid);
  const wanted = body.type === 'album' ? hits : hits.filter(t => t.mbid === body.mbid);
  if (wanted.length === 0) return null;
  const statuses: { id: number; status: string }[] = [];
  const ids = wanted.map(hit => {
    const existing = state.server.all('track').find(r => r.mbid_recording === hit.mbid && r.album_id === album.id);
    if (existing) {
      if (existing.status === 'not_found') state.server.upsert('track', { ...existing, status: 'adding' });
      statuses.push({ id: Number(existing.id), status: existing.status === 'not_found' ? 'adding' : String(existing.status) });
      return Number(existing.id);
    }
    const track = makeTrack({
      added_at: null,
      album_id: album.id,
      artist_id: Number(album.artist_id),
      id: nextId('track'),
      in_library: false,
      mbid_recording: hit.mbid,
      position: hits.indexOf(hit) + 1,
      status: 'adding',
      title: hit.title,
    });
    state.server.upsert('track', track);
    statuses.push({ id: track.id, status: 'adding' });
    return track.id;
  });
  return { album_id: album.id, track_ids: ids, tracks: statuses };
}

/** `GET /api/catalog/{artists|albums}/{mbid}`: каталог MusicBrainz из фикстуры поиска; `null` — такого mbid нет. */
function catalogRoute(kind: string, mbid: string): unknown {
  const libraryArtist = (id: string) =>
    state.server.all('artist').find(a => a.mbid === id && a.in_library)?.id ?? null;
  const libraryAlbum = (id: string) => state.server.all('album').find(a => a.mbid === id && a.in_library)?.id ?? null;
  if (kind === 'artists') {
    const hit = searchFixture.artists.find(a => a.mbid === mbid);
    if (!hit) return null;
    return {
      albums: searchFixture.albums
        .filter(a => a.artist_mbid === mbid)
        .map(a => ({ ...a, library_id: libraryAlbum(a.mbid) })),
      artist: {
        country: hit.country,
        disambiguation: hit.disambiguation,
        library_id: libraryArtist(mbid),
        mbid,
        name: hit.name,
      },
    };
  }
  const album = searchFixture.albums.find(a => a.mbid === mbid);
  if (!album) return null;
  const tracks = searchFixture.tracks
    .filter(t => t.album_mbid === mbid)
    .map((t, i) => {
      const own = state.server.all('track').find(r => r.mbid_recording === t.mbid && r.in_library);
      return {
        disc_no: 1,
        duration_ms: t.duration_ms,
        library_id: own?.id ?? null,
        mbid: t.mbid,
        position: i + 1,
        status: own?.status ?? null,
        title: t.title,
      };
    });
  return { album: { ...album, library_id: libraryAlbum(mbid) }, tracks };
}

/** Обработчик `/api/tracks/{id}/{stream|played|prefetch|audio-info}`. */
async function playbackRoute(req: Request, id: number, kind: string): Promise<Response> {
  const track = state.server.get('track', id);
  if (kind === 'played' && req.method === 'POST') {
    if (!track) return json(404, { error: { code: 'not_found', message: 'track not found' } });
    const play_count = Number(track.play_count ?? 0) + 1;
    state.server.upsert('track', { ...track, last_played_at: now(), play_count });
    return json(200, { play_count });
  }
  if (kind === 'prefetch' && req.method === 'POST') return json(202, { state: 'started' });
  if (kind === 'audio-info' && req.method === 'GET') {
    return json(200, {
      bit_depth: 16,
      bitrate_kbps: null,
      channels: 'stereo',
      codec: id === 9031 ? 'flac' : 'mp3',
      ext: 'flac',
      sample_rate: 44100,
      transcoded: false,
    });
  }
  if (kind !== 'stream' || (req.method !== 'GET' && req.method !== 'HEAD')) {
    return json(404, { error: { code: 'not_found', message: `no mock for ${kind}` } });
  }
  const delay = state.streamDelayMs.get(id);
  if (delay) await sleep(delay);
  const failure = STREAM_ERRORS[id];
  if (failure) return json(failure[0], { error: { code: failure[1], message: 'stream error' } });
  if (!track || !['found', 'ready'].includes(String(track.status))) {
    return json(409, { error: { code: 'track_not_playable', message: 'not playable' } });
  }
  const body = req.method === 'HEAD';
  const base = { 'cache-control': 'no-store', 'content-type': 'audio/wav' };
  if (track.playback === 'transcode') {
    const start = Number(new URL(req.url).searchParams.get('t') ?? 0);
    const data = wavFrom(start);
    return new Response(body ? null : new Uint8Array(data), {
      headers: { ...base, 'accept-ranges': 'none', 'content-length': String(data.length), 'x-nimbus-transcode': '1' },
      status: 200,
    });
  }
  const size = WAV.length;
  const etag = '"mock-wav-1"';
  // Как настоящий бэкенд: `If-Range` с чужим ETag отменяет Range (ответ — весь файл).
  const ifRange = req.headers.get('if-range');
  const rangeHeader = ifRange && ifRange !== etag ? '' : (req.headers.get('range') ?? '');
  const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  let start = 0;
  let end = size - 1;
  if (range) {
    if (range[1] === '') start = Math.max(0, size - Number(range[2]));
    else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start >= size) {
      return new Response(null, { headers: { 'content-range': `bytes */${size}` }, status: 416 });
    }
  }
  const slice = new Uint8Array(WAV.subarray(start, end + 1));
  const cutAt = state.streamCut.get(id);
  let payload: BodyInit | null = body ? null : slice;
  if (!body && cutAt !== undefined && cutAt < slice.length) {
    state.streamCut.delete(id);
    // Отдаём часть тела и рвём соединение: клиент видит обрыв потока посередине.
    payload = new ReadableStream({
      start(ctl) {
        ctl.enqueue(slice.subarray(0, cutAt));
      },
      async pull(ctl) {
        // Даём отправленной части дойти до клиента (через прокси), иначе обрыв приходит раньше первого байта.
        await Bun.sleep(150);
        ctl.error(new Error('connection reset'));
      },
    });
  }
  return new Response(payload, {
    headers: {
      ...base,
      'accept-ranges': 'bytes',
      'content-length': String(end - start + 1),
      etag,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    },
    status: range ? 206 : 200,
  });
}

/** Альбомы для тестов плеера (id 9xx — не пересекаются с `makeSmallLibrary`). */
function seedPlayerLibrary() {
  const artist = makeArtist({ added_at: now(), id: 900, name: 'Radiohead' });
  state.server.upsert('artist', artist);
  const album = (id: number, title: string) =>
    state.server.upsert('album', makeAlbum({ added_at: now(), artist_id: artist.id, id, title, year: 2001 }));
  album(903, 'Player Test');
  album(905, 'Transcode Test');
  const track = (id: number, albumId: number, position: number, title: string, over: Record<string, unknown> = {}) =>
    state.server.upsert(
      'track',
      makeTrack({
        added_at: now(),
        album_id: albumId,
        artist_id: artist.id,
        duration_ms: 5000,
        id,
        position,
        status: 'found',
        title,
        ...over,
      }),
    );
  // Song One → Broken Format (503 ffmpeg_missing) → Song Two → Song Three (ready) → Not Yet (adding)
  track(9031, 903, 1, 'Song One');
  track(9034, 903, 2, 'Broken Format');
  track(9032, 903, 3, 'Song Two');
  track(9033, 903, 4, 'Song Three', { status: 'ready' });
  track(9035, 903, 5, 'Not Yet', { status: 'adding' });
  track(9051, 905, 1, 'Image Track', { playback: 'transcode' });
}

/** Альбомы для офлайн-тестов (артист 920): «Offline Test» (923: три трека) и «Offline Transcode» (925: перекодируемый трек). */
function seedOfflineLibrary() {
  const artist = makeArtist({ added_at: now(), id: 920, name: 'Offline Artist' });
  state.server.upsert('artist', artist);
  for (const [id, title] of [[923, 'Offline Test'], [925, 'Offline Transcode']] as const) {
    state.server.upsert('album', makeAlbum({ added_at: now(), artist_id: artist.id, id, title, year: 2002 }));
  }
  const track = (id: number, albumId: number, position: number, title: string, over: Record<string, unknown> = {}) =>
    state.server.upsert(
      'track',
      makeTrack({ added_at: now(), album_id: albumId, artist_id: artist.id, duration_ms: 5000, id, position, status: 'ready', title, ...over }),
    );
  track(9231, 923, 1, 'Offline One');
  track(9232, 923, 2, 'Offline Two');
  track(9233, 923, 3, 'Offline Three');
  track(9251, 925, 1, 'Offline Image', { playback: 'transcode' });
}

// ---------------------------------------------------------------- плейлисты и источники

const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const poke = () => broadcast({ type: 'sync.poke' });

/** Плейлист в формате `PlaylistDto` (id — строка, как на сервере). */
function playlistDto(row: { id: number } & Record<string, unknown>) {
  const count = state.server.all('playlist_track').filter(r => r.playlist_id === row.id).length;
  return {
    created_at: row.created_at,
    id: String(row.id),
    kind: 'user',
    last_used_at: row.last_used_at,
    name: row.name,
    track_count: count,
  };
}

/** `/api/playlists[/{id}[/tracks[/{track}]]]`: изменяет те же данные, что отдаёт синхронизация. */
async function playlistRoute(req: Request, parts: string[]): Promise<Response> {
  if (state.playlistDelayMs && req.method !== 'GET') await sleep(state.playlistDelayMs);
  if (state.failPlaylists && req.method !== 'GET')
    return err(state.failPlaylists, 'internal', 'playlist request failed');
  const [, , rawId, sub, rawTrack] = parts; // api, playlists, id, tracks, track_id
  if (!rawId) {
    if (req.method === 'POST') {
      const body = (await req.json()) as { name?: string };
      const name = body.name?.trim() ?? '';
      if (!name || name.length > 100) return err(400, 'bad_name', 'playlist name must be 1..100 characters');
      const stamp = now();
      const row = { created_at: stamp, id: nextId('playlist'), last_used_at: stamp, name };
      state.server.upsert('playlist', row);
      poke();
      return json(201, playlistDto(row));
    }
    return err(404, 'not_found', 'no mock');
  }
  if (rawId === 'favorites') return err(409, 'playlist_dynamic', 'Favorites is built automatically from play counts');
  const id = Number(rawId);
  const playlist = state.server.get('playlist', id);
  if (!playlist) return err(404, 'not_found', 'playlist not found');
  if (!sub && req.method === 'DELETE') {
    for (const r of state.server.all('playlist_track'))
      if (r.playlist_id === id) state.server.remove('playlist_track', r.id);
    state.server.remove('playlist', id);
    poke();
    return new Response(null, { status: 204 });
  }
  if (sub === 'tracks' && !rawTrack && req.method === 'POST') {
    const { track_id } = (await req.json()) as { track_id: number };
    if (!state.server.get('track', track_id)) return err(404, 'not_found', 'playlist or track not found');
    if (!state.server.all('playlist_track').some(r => r.playlist_id === id && r.track_id === track_id)) {
      state.server.upsert('playlist_track', {
        added_at: now(),
        id: nextId('playlist_track'),
        playlist_id: id,
        track_id,
      });
    }
    state.server.upsert('playlist', { ...playlist, last_used_at: now() });
    poke();
    return new Response(null, { status: 204 });
  }
  if (sub === 'tracks' && rawTrack && req.method === 'DELETE') {
    for (const r of state.server.all('playlist_track')) {
      if (r.playlist_id === id && r.track_id === Number(rawTrack)) state.server.remove('playlist_track', r.id);
    }
    poke();
    return new Response(null, { status: 204 });
  }
  return err(404, 'not_found', 'no mock');
}

const torrent = (id: number, source: string, title: string): MockTorrent => ({
  id,
  info_hash: `hash${id}`,
  kind: 'album',
  leechers: 2,
  meta_status: 'ok',
  seeders: 30,
  size_bytes: 250 * 1024 * 1024,
  source,
  title,
});
const albumTorrents = (albumId: number): MockTorrent[] => [
  torrent(albumId * 10 + 1, 'rutracker', `Album ${albumId} [FLAC]`),
  torrent(albumId * 10 + 2, 'tpb', `Album ${albumId} (MP3)`),
  ...(state.extraTorrents.get(albumId) ?? []),
];

/** Источники трека: основной (сомнительный, если у трека `needs_confirmation`) и альтернатива. */
function sourcesOf(trackId: number): MockSource[] {
  const found = state.trackSources.get(trackId);
  if (found) return found;
  const track = state.server.get('track', trackId);
  const [first, second] = albumTorrents(Number(track?.album_id ?? 0));
  const list: MockSource[] = [
    {
      file_index: 0,
      id: trackId * 10 + 1,
      is_primary: true,
      match_score: track?.needs_confirmation ? 0.62 : 0.95,
      needs_confirmation: Boolean(track?.needs_confirmation),
      path: `Album/${String(track?.position ?? 1).padStart(2, '0')} ${String(track?.title ?? 'track')}.flac`,
      size_bytes: 30 * 1024 * 1024,
      torrent: first!,
    },
    {
      file_index: 3,
      id: trackId * 10 + 2,
      is_primary: false,
      match_score: 0.8,
      needs_confirmation: false,
      path: `Alt/${String(track?.title ?? 'track')}.mp3`,
      size_bytes: 8 * 1024 * 1024,
      torrent: second!,
    },
  ];
  state.trackSources.set(trackId, list);
  return list;
}

/** После ручного выбора/подтверждения трек больше не требует проверки (как на сервере). */
function settleTrack(trackId: number) {
  const track = state.server.get('track', trackId);
  const pending = sourcesOf(trackId).some(s => s.is_primary && s.needs_confirmation);
  if (track && track.needs_confirmation && !pending)
    state.server.upsert('track', { ...track, needs_confirmation: false });
}

const MAGNET = /^magnet:\?(?:.*&)?xt=urn:btih:([0-9a-f]{40}|[a-z2-7]{32})(?:&|$)/i;

/** `/api/albums/{id}/{torrents|retry}`, `/api/tracks/{id}/{sources|source|retry}`, `/api/torrents/{id}/files`. */
async function sourcesRoute(req: Request, parts: string[]): Promise<Response | null> {
  const [, kind, rawId, sub, rawSource, action] = parts;
  const id = Number(rawId);
  if (kind === 'albums' && sub === 'torrents' && rawSource !== undefined && action === 'use' && req.method === 'POST') {
    if (!state.server.get('album', id)) return err(404, 'not_found', 'album not found');
    const tor = albumTorrents(id).find(t => t.id === Number(rawSource));
    if (!tor) return err(404, 'not_found', 'album torrent not found');
    if (tor.meta_status !== 'ok') return err(409, 'torrent_no_files', 'torrent metadata is not received yet');
    const before = state.usedTorrent.get(id) ?? albumTorrents(id)[0]!.id;
    state.usedTorrent.set(id, tor.id);
    const tracks = state.server.all('track').filter(t => t.album_id === id);
    const switched = before === tor.id ? [] : tracks.map(t => Number(t.id));
    for (const t of tracks) {
      if (switched.includes(Number(t.id)) && t.status === 'ready') state.server.upsert('track', { ...t, status: 'found' });
    }
    poke();
    return json(200, { matched: tracks.length, switched_track_ids: switched, unmatched: 0 });
  }
  if (kind === 'albums' && sub === 'torrents') {
    if (!state.server.get('album', id)) return err(404, 'not_found', 'album not found');
    if (req.method === 'GET') {
      const used = state.usedTorrent.get(id) ?? albumTorrents(id)[0]!.id;
      return json(
        200,
        albumTorrents(id).map((t, i) => ({
          files_count: 12,
          formats: /mp3/i.test(t.title) ? ['MP3'] : /flac/i.test(t.title) ? ['FLAC'] : [],
          matched_tracks: 10 - i,
          primary_tracks: t.id === used ? 10 : 0,
          rank_score: 0.9 - i / 10,
          torrent: t,
          verified: i === 0,
        })),
      );
    }
    if (req.method === 'POST') {
      const { magnet } = (await req.json()) as { magnet: string };
      const hit = MAGNET.exec(magnet.trim());
      if (!hit) return err(400, 'invalid_magnet', 'not a magnet link');
      const added = {
        ...torrent(id * 10 + 3 + (state.extraTorrents.get(id)?.length ?? 0), 'manual', `Manual ${hit[1]!.slice(0, 8)}`),
        meta_status: 'pending',
      };
      state.extraTorrents.set(id, [...(state.extraTorrents.get(id) ?? []), added]);
      return json(202, { queued: true, torrent: added });
    }
  }
  if (kind === 'albums' && sub === 'retry' && req.method === 'POST') {
    if (!state.server.get('album', id)) return err(404, 'not_found', 'album not found');
    let reset = 0;
    for (const t of state.server.all('track')) {
      if (t.album_id === id && t.status === 'not_found') {
        state.server.upsert('track', { ...t, status: 'adding' });
        reset++;
      }
    }
    poke();
    return json(202, { queued: true, tracks_reset: reset });
  }
  if (kind === 'tracks') {
    const track = state.server.get('track', id);
    if (!track) return err(404, 'not_found', 'track not found');
    if (sub === 'sources' && !rawSource && req.method === 'GET') return json(200, sourcesOf(id));
    if (sub === 'sources' && action === 'confirm' && req.method === 'POST') {
      const source = sourcesOf(id).find(s => s.id === Number(rawSource));
      if (!source) return err(404, 'not_found', 'source not found');
      source.needs_confirmation = false;
      settleTrack(id);
      poke();
      return json(200, source);
    }
    if (sub === 'source' && req.method === 'PUT') {
      const body = (await req.json()) as {
        source_id?: number | null;
        torrent_id?: number | null;
        file_index?: number | null;
      };
      const list = sourcesOf(id);
      let chosen = body.source_id != null ? list.find(s => s.id === body.source_id) : undefined;
      if (!chosen && body.torrent_id != null && body.file_index != null) {
        const tor = albumTorrents(Number(track.album_id)).find(t => t.id === body.torrent_id);
        if (!tor) return err(404, 'not_found', 'torrent not found');
        chosen = {
          file_index: body.file_index,
          id: id * 10 + 5 + list.length,
          is_primary: false,
          match_score: 1,
          needs_confirmation: false,
          path: `Picked/${body.file_index}.flac`,
          size_bytes: 1024,
          torrent: tor,
        };
        list.push(chosen);
      }
      if (!chosen) return err(400, 'bad_source', 'choose an existing source or torrent+file');
      for (const s of list) s.is_primary = s === chosen;
      chosen.needs_confirmation = false;
      settleTrack(id);
      poke();
      return json(200, chosen);
    }
    if (sub === 'retry' && req.method === 'POST') {
      if (track.status === 'ready') return err(409, 'track_ready', 'The track is already downloaded');
      state.server.upsert('track', { ...track, status: 'adding' });
      poke();
      return json(202, { queued: true, tracks_reset: 1 });
    }
  }
  if (kind === 'torrents' && sub === 'files' && req.method === 'GET') {
    return json(200, [
      { ext: 'flac', file_index: 0, matched_track_id: null, path: 'Album/01 Intro.flac', size_bytes: 30 * 1024 * 1024 },
      { ext: 'flac', file_index: 1, matched_track_id: null, path: 'Album/02 Song.flac', size_bytes: 28 * 1024 * 1024 },
      { ext: 'jpg', file_index: 2, matched_track_id: null, path: 'Album/cover.jpg', size_bytes: 200 * 1024 },
    ]);
  }
  return null;
}

/** Альбом с треками для сценариев источников: 9131 found, 9132 требует подтверждения, 9133 не найден. */
function seedSourcesLibrary() {
  const artist = makeArtist({ added_at: now(), id: 910, name: 'Sources Band' });
  state.server.upsert('artist', artist);
  state.server.upsert(
    'album',
    makeAlbum({ added_at: now(), artist_id: artist.id, id: 913, title: 'Sources Test', year: 2005 }),
  );
  const track = (id: number, position: number, title: string, over: Record<string, unknown> = {}) =>
    state.server.upsert(
      'track',
      makeTrack({
        added_at: now(),
        album_id: 913,
        artist_id: artist.id,
        duration_ms: 5000,
        id,
        position,
        status: 'found',
        title,
        ...over,
      }),
    );
  track(9131, 1, 'Plain Song');
  track(9132, 2, 'Doubtful Song', { needs_confirmation: true });
  track(9133, 3, 'Lost Song', { status: 'not_found' });
}

// ---------------------------------------------------------------- настройки сервера
const MASK = '••••';
const SECRET_PATHS = ['providers.torznab.api_key', 'providers.rutracker.password', 'providers.rutracker.cookie'];
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function defaultSettings(): Json {
  return {
    matching: { accept: 0.8, confirm: 0.65 },
    musicbrainz: { base_url: 'https://musicbrainz.org/ws/2/', burst: 3, max_concurrent: 2, rate_per_sec: 1 },
    performance: {
      discover_workers: 8,
      download_concurrency: 4,
      import_workers: 2,
      metadata_concurrency: 16,
      metadata_timeout_secs: 30,
      verify_workers: 16,
    },
    playback: { prefetch_next: true, transcode_alac: false, transcode_lossy_codec: 'opus' },
    providers: { rutracker: null, tpb_enabled: true, torznab: null },
    search: {
      auto_retry: true,
      format_prefs: ['flac', 'alac', 'mp3_320', 'mp3_v0', 'aac', 'ape_wv', 'mp3_other'],
      max_candidates: 8,
      skip_secondary_types: ['EP', 'Compilation', 'Live'],
    },
    storage: { auto_download: 'off', cache_limit_gb: 50, seed_ratio: 1, seeding: true },
  };
}

function getAt(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, k) => (isObj(cur) ? cur[k] : undefined), obj);
}

/** Слияние патча, как на сервере; пустой секрет и маска сохранённое значение не меняют. */
function mergeSettings(base: Json, patch: Json, prefix = ''): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const path = prefix + k;
    if (SECRET_PATHS.includes(path) && (v === '' || v === MASK)) continue;
    out[k] = isObj(v) ? mergeSettings(isObj(out[k]) ? (out[k] as Json) : {}, v, `${path}.`) : v;
  }
  return out;
}

function maskSettings(settings: Json): Json {
  const copy = structuredClone(settings);
  for (const path of SECRET_PATHS) {
    const keys = path.split('.');
    const last = keys.pop() as string;
    const parent = getAt(copy, keys.join('.'));
    if (isObj(parent) && parent[last]) parent[last] = MASK;
    else if (isObj(parent)) parent[last] = null;
  }
  return copy;
}

/** Первая ошибка валидации как `[поле, сообщение]` (диапазоны — как в `core/src/settings.rs`). */
function validateSettings(s: Json): [string, string] | null {
  const num = (path: string) => getAt(s, path) as number;
  if (num('matching.confirm') > num('matching.accept'))
    return ['matching.confirm', 'matching.confirm must not exceed matching.accept'];
  if (num('storage.cache_limit_gb') < 1) return ['storage.cache_limit_gb', 'storage.cache_limit_gb must be at least 1'];
  if (num('musicbrainz.burst') < 1 || num('musicbrainz.burst') > 20)
    return ['musicbrainz.burst', 'musicbrainz.burst must be between 1 and 20'];
  if (!String(getAt(s, 'musicbrainz.base_url')).endsWith('/'))
    return ['musicbrainz.base_url', 'musicbrainz.base_url must be an http(s) URL ending with "/"'];
  for (const k of ['discover_workers', 'verify_workers', 'import_workers', 'metadata_concurrency']) {
    if (num(`performance.${k}`) < 1 || num(`performance.${k}`) > 64)
      return [`performance.${k}`, `performance.${k} must be between 1 and 64`];
  }
  const url = getAt(s, 'providers.torznab.url');
  if (isObj(getAt(s, 'providers.torznab')) && !url)
    return ['providers.torznab.url', 'providers.torznab.url must not be empty'];
  return null;
}

const providersFingerprint = (s: Json) => JSON.stringify(getAt(s, 'providers'));

async function settingsRoute(req: Request, path: string): Promise<Response | null> {
  if (path === '/api/settings' && req.method === 'GET') return json(200, maskSettings(state.settings));
  if (path === '/api/settings' && req.method === 'PUT') {
    if (state.settingsFault)
      return json(state.settingsFault, { error: { code: 'internal', message: 'internal server error' } });
    const merged = mergeSettings(state.settings, (await req.json()) as Json);
    const bad = validateSettings(merged);
    if (bad) return json(400, { error: { code: 'invalid_settings', field: bad[0], message: bad[1] } });
    const suggest = providersFingerprint(merged) !== providersFingerprint(state.settings);
    state.settings = merged;
    state.prefetchNext = getAt(merged, 'playback.prefetch_next') === true;
    const restart = JSON.stringify(merged.performance) !== JSON.stringify((defaultSettings() as Json).performance);
    return json(200, { ...maskSettings(merged), restart_required: restart, suggest_retry_missing: suggest });
  }
  if (path === '/api/storage') {
    const gb = 1024 ** 3;
    return json(200, {
      files: 412,
      limit_bytes: (getAt(state.settings, 'storage.cache_limit_gb') as number) * gb,
      over_limit: false,
      pinned_bytes: 2 * gb,
      pinned_files: 38,
      torrents_active: 1,
      used_bytes: 12 * gb,
    });
  }
  if (path === '/api/settings/providers/test' && req.method === 'POST') {
    const { provider } = (await req.json()) as { provider: string };
    const configured =
      provider === 'tpb'
        ? getAt(state.settings, 'providers.tpb_enabled')
        : getAt(state.settings, `providers.${provider}`);
    if (!configured) return json(400, { error: { code: 'not_configured', message: `${provider} is not configured` } });
    return json(
      200,
      state.providerTestOk
        ? { message: 'OK: 12 results', ok: true, sample_count: 12 }
        : { message: 'Login rejected', ok: false, sample_count: 0 },
    );
  }
  if (path === '/api/settings/reimport-artists' && req.method === 'POST') return json(200, { queued: 3 });
  if (path === '/api/acquisition/retry' && req.method === 'POST') return json(202, { queued: 2 });
  return null;
}

const acquisition = createAcquisitionMock({
  broadcast: event => broadcast(event),
  json,
  now,
  poke: () => poke(),
  server: () => state.server,
});

const authed = (req: Request) => !state.authRequired || cookieOf(req) === TOKEN;
const broadcast = (event: unknown) => clients.forEach(ws => ws.send(JSON.stringify(event)));

Bun.serve({
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    // В журнал потока попадает и запрос (`?t=` у перекодируемых треков).
    if (!path.startsWith('/__test/'))
      state.log.push(
        `${req.method} ${path}${path.endsWith('/stream') ? new URL(req.url).search : ''}${
          path.endsWith('/stream') && req.url.includes('download=1') && req.headers.get('range') ? ` ${req.headers.get('range')}` : ''
        }`,
      );

    // Фото артиста: 1×1 PNG (e2e кэша изображений service worker).
    if (path.startsWith('/api/artist-image/')) {
      // `nophoto-*` — артист без фото: 404 `no_image`, как у бэкенда (e2e запоминания «нет фото» в service worker).
      if (path.startsWith('/api/artist-image/nophoto')) return json(404, { code: 'no_image', message: 'no artist image' });
      return new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
    }
    if (path === '/api/health') return json(200, { db: true, status: 'ok', version: 'mock' });
    if (path === '/api/auth/session') {
      return json(200, { auth_required: state.authRequired, authenticated: authed(req) });
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = (await req.json()) as { token?: string };
      if (state.authRequired && body.token?.trim() !== TOKEN) {
        return json(401, { error: { code: 'unauthorized', message: 'invalid token' } });
      }
      return new Response(null, {
        headers: { 'set-cookie': `${COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Lax` },
        status: 204,
      });
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      return new Response(null, {
        headers: { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` },
        status: 204,
      });
    }

    // ---------------------------------------------------------------- воспроизведение
    const trackRoute = /^\/api\/tracks\/(\d+)\/(stream|played|prefetch|audio-info)$/.exec(path);
    if (trackRoute) {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      return playbackRoute(req, Number(trackRoute[1]), trackRoute[2]);
    }
    // ---------------------------------------------------------------- плейлисты и источники
    if (path.startsWith('/api/playlists')) {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      return playlistRoute(req, path.split('/').filter(Boolean));
    }
    if (/^\/api\/(albums\/\d+\/(torrents|retry)|tracks\/\d+\/(sources|source|retry)|torrents\/\d+\/files)/.test(path)) {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      const handled = await sourcesRoute(req, path.split('/').filter(Boolean));
      if (handled) return handled;
    }

    if (/^\/api\/(acquisition|downloads|jobs|albums\/\d+\/download)/.test(path)) {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      const handled = await acquisition.route(req, path);
      if (handled) return handled;
    }

    if (
      path === '/api/settings' ||
      path === '/api/storage' ||
      path.startsWith('/api/settings/') ||
      path === '/api/acquisition/retry'
    ) {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      const handled = await settingsRoute(req, path);
      if (handled) return handled;
    }

    if (path === '/api/search') {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      if (state.faults.delayMs) await sleep(state.faults.delayMs);
      if (state.faults.failStatus) {
        return json(state.faults.failStatus, {
          error: { code: 'mb_unavailable', message: 'MusicBrainz is unavailable' },
        });
      }
      const q = new URL(req.url).searchParams.get('q') ?? '';
      return json(200, { ...searchFixture, query: q });
    }
    if (path === '/api/play' && req.method === 'POST') {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      const result = playRoute((await req.json()) as { type: string; mbid: string; album_mbid?: string | null });
      if (!result) return json(404, { error: { code: 'mb_not_found', message: 'not found in MusicBrainz' } });
      broadcast({ type: 'sync.poke' });
      return json(200, result);
    }
    if (path.startsWith('/api/catalog/')) {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      if (state.faults.delayMs) await sleep(state.faults.delayMs);
      if (state.faults.failStatus) {
        return json(state.faults.failStatus, {
          error: { code: 'mb_unavailable', message: 'MusicBrainz is unavailable' },
        });
      }
      const [, , kind = '', mbid = ''] = path.split('/').filter(Boolean); // api, catalog, kind, mbid
      const body = catalogRoute(kind, decodeURIComponent(mbid));
      if (!body) return json(404, { error: { code: 'mb_not_found', message: 'not found in MusicBrainz' } });
      return json(200, body);
    }
    if (path === '/api/library' && req.method === 'POST') {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      if (state.faults.addDelayMs) await sleep(state.faults.addDelayMs);
      if (state.faults.addFailStatus) {
        return json(state.faults.addFailStatus, {
          error: { code: 'mb_not_found', message: 'not found in MusicBrainz' },
        });
      }
      const result = addToLibrary((await req.json()) as AddBody);
      if (!result) return json(404, { error: { code: 'mb_not_found', message: 'not found in MusicBrainz' } });
      broadcast({ type: 'sync.poke' });
      return json(result.status, result.body);
    }
    if (path.startsWith('/api/artists/') || path.startsWith('/api/library/')) {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      const parts = path.split('/').filter(Boolean); // api, artists|library, id|type, [id|import]
      if (parts[1] === 'artists' && req.method === 'GET') {
        const id = Number(parts[2]);
        const row = state.server.get('artist', id);
        if (!row) return json(404, { error: { code: 'not_found', message: 'no artist' } });
        return json(200, {
          albums: [],
          artist: { ...row, album_count: 0, import: state.imports.get(id), track_count: 0 },
        });
      }
      if (parts[1] === 'artists' && parts[3] === 'import' && req.method === 'POST') {
        state.imports.set(Number(parts[2]), { attempt: 1, max_attempts: 8, state: 'importing' });
        broadcast({ entity: 'artist', id: Number(parts[2]), type: 'library.changed' });
        return new Response(null, { status: 204 });
      }
      if (parts[1] === 'library' && req.method === 'DELETE') {
        if (state.failDelete) return json(500, { error: { code: 'internal', message: 'delete failed' } });
        removeFromLibrary(parts[2] as 'artist' | 'album', Number(parts[3]));
        broadcast({ type: 'sync.poke' });
        return new Response(null, { status: 204 });
      }
    }

    if (path === '/api/ws') {
      if (!authed(req) || state.blockWs) return json(401, { error: { code: 'unauthorized', message: 'no' } });
      return server.upgrade(req) ? undefined : json(400, { error: { code: 'bad_request', message: 'upgrade' } });
    }
    if (path.startsWith('/api/sync/')) {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      if (path.endsWith('/snapshot') && state.snapshotDelayMs) {
        await new Promise(r => setTimeout(r, state.snapshotDelayMs));
      }
      return state.server.fetch(req);
    }

    // Служебные эндпоинты тестов.
    if (path === '/__test/reset') {
      reset((await req.json().catch(() => ({}))) as Parameters<typeof reset>[0]);
      return json(200, { ok: true });
    }
    if (path === '/__test/emit') {
      broadcast(await req.json());
      return json(200, { clients: clients.size });
    }
    if (path === '/__test/seed') {
      const q = new URL(req.url).searchParams;
      const rows = makeBigLibrary({
        albums: Number(q.get('albums') ?? 8),
        artists: Number(q.get('artists') ?? 3),
        tracks: Number(q.get('tracks') ?? 80),
      });
      state.server = new FakeSyncServer().load(rows);
      return json(200, { tracks: rows.tracks.length });
    }
    if (path === '/__test/import') {
      const body = (await req.json()) as { id: number; status: ImportStatus | null };
      if (body.status) state.imports.set(body.id, body.status);
      else state.imports.delete(body.id);
      return json(200, { ok: true });
    }
    if (path === '/__test/player') {
      const body = (await req.json().catch(() => ({}))) as { delayMs?: Record<string, number>; prefetchNext?: boolean };
      seedPlayerLibrary();
      state.streamDelayMs = new Map(Object.entries(body.delayMs ?? {}).map(([id, ms]) => [Number(id), ms]));
      state.prefetchNext = body.prefetchNext ?? true;
      (state.settings.playback as Json).prefetch_next = state.prefetchNext;
      return json(200, { ok: true });
    }
    if (path === '/__test/offline') {
      const body = (await req.json().catch(() => ({}))) as { delayMs?: Record<string, number>; cut?: Record<string, number> };
      seedOfflineLibrary();
      state.streamDelayMs = new Map(Object.entries(body.delayMs ?? {}).map(([id, ms]) => [Number(id), ms]));
      state.streamCut = new Map(Object.entries(body.cut ?? {}).map(([id, n]) => [Number(id), n]));
      return json(200, { ok: true });
    }
    if (path === '/__test/settings') {
      if (req.method === 'POST') {
        const body = (await req.json()) as { failStatus?: number | null; providerTestOk?: boolean };
        state.settingsFault = body.failStatus ?? null;
        state.providerTestOk = body.providerTestOk ?? true;
        return json(200, { ok: true });
      }
      return json(200, state.settings);
    }
    if (path === '/__test/acquisition' || path === '/__test/progress' || path === '/__test/search-result') {
      const handled = await acquisition.testRoute(req, path);
      if (handled) return handled;
    }
    if (path === '/__test/sources') {
      seedSourcesLibrary();
      return json(200, { ok: true });
    }
    if (path === '/__test/playlists') {
      const body = (await req.json().catch(() => ({}))) as { failStatus?: number | null; delayMs?: number };
      state.failPlaylists = body.failStatus ?? null;
      state.playlistDelayMs = body.delayMs ?? 0;
      return json(200, { ok: true });
    }
    if (path === '/__test/search') {
      state.faults = { ...NO_SEARCH_FAULTS, ...((await req.json()) as Partial<Search>) };
      return json(200, { ok: true });
    }
    if (path === '/__test/fail-delete') {
      state.failDelete = ((await req.json()) as { fail: boolean }).fail;
      return json(200, { ok: true });
    }
    if (path === '/__test/mutate') {
      const body = (await req.json()) as {
        entity: Entity;
        id?: number;
        patch?: Record<string, unknown>;
        row?: { id: number };
        remove?: number;
        event?: unknown;
      };
      if (body.patch && body.id !== undefined) {
        const current = state.server.get(body.entity, body.id);
        if (current) state.server.upsert(body.entity, { ...current, ...body.patch });
      }
      if (body.event) broadcast(body.event);
      if (body.row) state.server.upsert(body.entity, body.row);
      if (body.remove !== undefined) state.server.remove(body.entity, body.remove);
      broadcast({ type: 'sync.poke' });
      return json(200, { txid: state.server.txid });
    }
    if (path === '/__test/ws') {
      const body = (await req.json()) as { block: boolean };
      state.blockWs = body.block;
      dropClients();
      return json(200, { ok: true });
    }
    if (path === '/__test/log') return json(200, { clients: clients.size, log: state.log });

    return json(404, { error: { code: 'not_found', message: `no mock for ${path}` } });
  },
  port: PORT,
  websocket: {
    close: ws => void clients.delete(ws),
    message: () => undefined,
    open: ws => void clients.add(ws),
  },
});

process.stdout.write(`mock backend on :${PORT}\n`);
