import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Помощники нагрузочных и отказоустойчивых сценариев на полном стеке (docker compose с хоста).
// Стек поднимает `scripts/load.sh` (проект `nimbus-load`, порт 8011, фейковые внешние сервисы).

const run = promisify(execFile);

export const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8011';
export const token = process.env.LOAD_TOKEN ?? 'load-token';
export const project = process.env.LOAD_PROJECT ?? 'nimbus-load';
const files = ['-f', 'docker-compose.yml', '-f', 'docker-compose.load.yml'];

/** Каталог репозитория (тесты запускаются из `client/`). */
const root = new URL('../../../', import.meta.url).pathname;

export async function compose(args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run('docker', ['compose', '-p', project, ...files, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** SQL в БД стека (psql в контейнере `db`); результат — строки, поля через `|`. */
export async function sql(query: string): Promise<string[][]> {
  const out = await compose(['exec', '-T', 'db', 'psql', '-U', 'nimbus', 'nimbus', '-tA', '-F', '|', '-c', query]);
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !/^(UPDATE|INSERT|DELETE) \d+$/.test(l))
    .map(l => l.split('|'));
}

/** Ждёт `check` с опросом; без фиксированных пауз сверх интервала опроса. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | false | null | undefined>,
  { timeoutMs = 120_000, intervalMs = 500 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

export interface Health {
  db: unknown;
  engine?: { torrents: number };
  jobs?: { queued: number; running: number; failed_24h: number };
}

export async function health(): Promise<{ status: number; body?: Health }> {
  try {
    const r = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(3000) });
    return { status: r.status, body: r.ok ? ((await r.json()) as Health) : undefined };
  } catch {
    return { status: 0 };
  }
}

export async function waitHealthy(timeoutMs = 120_000) {
  return waitFor('health 200', async () => (await health()).status === 200, { timeoutMs, intervalMs: 500 });
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const r = await fetch(`${baseURL}${path}`, {
    ...init,
    body,
    headers: { ...headers, ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? safeJson(text) : null) as T };
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** Замер запроса через curl: время, размер тела «по проводу» (gzip), код. */
export async function curlTiming(path: string, headers: string[] = []) {
  const args = ['-s', '-o', '/dev/null', '-H', `Authorization: Bearer ${token}`, '-H', 'Accept-Encoding: gzip'];
  for (const h of headers) args.push('-H', h);
  args.push('-w', '%{http_code} %{size_download} %{time_total}', `${baseURL}${path}`);
  const { stdout } = await run('curl', args);
  const [code, size, time] = stdout.trim().split(' ');
  return { status: Number(code), bytes: Number(size), seconds: Number(time) };
}

export async function artistMbid(i: number): Promise<string> {
  return `a0000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
}

/** Использованная память контейнера бэкенда, МиБ. */
export async function backendMemMiB(): Promise<number> {
  const id = (await compose(['ps', '-q', 'nimbus'])).trim();
  const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', id]);
  const m = /^([\d.]+)\s*(KiB|MiB|GiB)/.exec(stdout.trim());
  if (!m) return NaN;
  const v = Number(m[1]);
  return m[2] === 'GiB' ? v * 1024 : m[2] === 'KiB' ? v / 1024 : v;
}
