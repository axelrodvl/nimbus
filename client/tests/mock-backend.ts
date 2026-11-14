// Мок бэкенда для Playwright (запускается под bun). Состояние живёт в памяти процесса; тесты идут последовательно
// и сбрасывают его через `POST /__test/reset`. Данные синхронизации отдаёт тот же `FakeSyncServer`, что и unit-тесты.
import { FakeSyncServer, makeSmallLibrary } from '../src/test/factories';

const PORT = Number(process.env.MOCK_BACKEND_PORT ?? 4011);
const TOKEN = 'secret';
const COOKIE = 'nimbus_token';

type Entity = Parameters<FakeSyncServer['upsert']>[0];

const state = {
  authRequired: false,
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
    if (path === '/__test/mutate') {
      const body = (await req.json()) as { entity: Entity; row?: { id: number }; remove?: number };
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
