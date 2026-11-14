// Мок бэкенда для Playwright (запускается под bun). Состояние живёт в памяти процесса; тесты идут последовательно
// и сбрасывают его через `POST /__test/reset`. Данные синхронизации отдаёт тот же `FakeSyncServer`, что и unit-тесты.
import { FakeSyncServer, makeBigLibrary, makeSmallLibrary } from '../src/test/factories';

const PORT = Number(process.env.MOCK_BACKEND_PORT ?? 4011);
const TOKEN = 'secret';
const COOKIE = 'nimbus_token';

type Entity = Parameters<FakeSyncServer['upsert']>[0];

type ImportStatus = { attempt: number; max_attempts: number; state: string; error?: string; retry_at?: string };

const state = {
  authRequired: false,
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
