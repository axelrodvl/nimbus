// Мок бэкенда для Playwright (запускается под bun). Состояние живёт в памяти процесса; тесты идут последовательно
// и сбрасывают его через `POST /__test/reset`. Данные синхронизации отдаёт тот же `FakeSyncServer`, что и unit-тесты.
import { FakeSyncServer, makeAlbum, makeArtist, makeBigLibrary, makeSmallLibrary, makeTrack } from '../src/test/factories';
import searchFixture from './fixtures/search-radiohead.json';

const PORT = Number(process.env.MOCK_BACKEND_PORT ?? 4011);
const TOKEN = 'secret';
const COOKIE = 'nimbus_token';

type Entity = Parameters<FakeSyncServer['upsert']>[0];

type ImportStatus = { attempt: number; max_attempts: number; state: string; error?: string; retry_at?: string };

type Search = { delayMs: number; failStatus: number | null; addDelayMs: number; addFailStatus: number | null };
const NO_SEARCH_FAULTS: Search = { addDelayMs: 0, addFailStatus: null, delayMs: 0, failStatus: null };

const state = {
  authRequired: false,
  faults: { ...NO_SEARCH_FAULTS },
  failDelete: false,
  imports: new Map<number, ImportStatus>(),
  blockWs: false,
  log: [] as string[],
  server: new FakeSyncServer().load(makeSmallLibrary()),
  snapshotDelayMs: 0,
};
const clients = new Set<MockWebSocket>();

function reset(opts: { authRequired?: boolean; snapshotDelayMs?: number }) {
  state.authRequired = opts.authRequired ?? false;
  state.snapshotDelayMs = opts.snapshotDelayMs ?? 0;
  state.blockWs = false;
  state.failDelete = false;
  state.faults = { ...NO_SEARCH_FAULTS };
  state.imports.clear();
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
    return { body: { id: artist.id, status: exists ? 'exists' : 'importing', type: 'artist' }, status: exists ? 200 : 202 };
  }
  if (body.type === 'album') {
    const album = ensureAlbum(body.mbid, true);
    if (!album) return null;
    state.server.upsert('album', { ...album, in_library: true });
    if (!state.server.all('track').some(t => t.album_id === album.id)) {
      for (let position = 1; position <= 3; position++) {
        state.server.upsert(
          'track',
          makeTrack({ added_at: now(), album_id: album.id, artist_id: Number(album.artist_id), id: nextId('track'), position, status: 'adding', title: `${String(album.title)} · ${position}` }),
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

const authed = (req: Request) => !state.authRequired || cookieOf(req) === TOKEN;
const broadcast = (event: unknown) => clients.forEach(ws => ws.send(JSON.stringify(event)));

Bun.serve({
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith('/__test/')) state.log.push(`${req.method} ${path}`);

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

    if (path === '/api/search') {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      if (state.faults.delayMs) await sleep(state.faults.delayMs);
      if (state.faults.failStatus) {
        return json(state.faults.failStatus, { error: { code: 'mb_unavailable', message: 'MusicBrainz is unavailable' } });
      }
      const q = new URL(req.url).searchParams.get('q') ?? '';
      return json(200, { ...searchFixture, query: q });
    }
    if (path === '/api/library' && req.method === 'POST') {
      if (!authed(req)) return json(401, { error: { code: 'unauthorized', message: 'login required' } });
      if (state.faults.addDelayMs) await sleep(state.faults.addDelayMs);
      if (state.faults.addFailStatus) {
        return json(state.faults.addFailStatus, { error: { code: 'mb_not_found', message: 'not found in MusicBrainz' } });
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
        return json(200, { albums: [], artist: { ...row, album_count: 0, import: state.imports.get(id), track_count: 0 } });
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
