// Мок бэкенда для Playwright. Состояние живёт в памяти процесса; каждый шаг клиента дополняет мок.
import { createServer, type ServerResponse } from 'node:http';

const PORT = Number(process.env.MOCK_BACKEND_PORT ?? 4011);

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://mock').pathname;
  if (path === '/api/health') return send(res, 200, { db: true, status: 'ok', version: 'mock' });
  if (path === '/api/auth/session') return send(res, 200, { auth_required: false, authenticated: true });
  send(res, 404, { error: { code: 'not_found', message: `no mock for ${path}` } });
}).listen(PORT, () => process.stdout.write(`mock backend on :${PORT}\n`));
