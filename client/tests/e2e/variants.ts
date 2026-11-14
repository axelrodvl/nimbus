// Варианты сборки для e2e обновления PWA: копия `dist/` с другой версией (и переименованным основным чанком, чтобы
// precache нового service worker не подхватил старое содержимое по тому же URL) и статический сервер с проксированием `/api`.
import { cpSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Копия `dist/` с версией `to` вместо `from`; возвращает каталог варианта. */
export function makeVariant(from: string, to: string): string {
  const out = mkdtempSync(join(tmpdir(), 'nimbus-variant-'));
  cpSync(resolve('dist'), out, { recursive: true });
  const files = [...walk(out)].filter(f => /\.(js|html|webmanifest)$/.test(f));
  const literals = ['"', "'", '`'].map(q => `${q}${from}${q}`);
  const withVersion = (text: string, replace?: string) =>
    literals.reduce((t, l) => (t.includes(l) && replace ? t.split(l).join(`"${replace}"`) : t), text);
  const holder = files.find(f => f.includes('/assets/') && literals.some(l => readFileSync(f, 'utf8').includes(l)));
  if (!holder) throw new Error(`версия ${from} не найдена в сборке`);
  const oldName = holder.split('/').pop()!;
  const newName = oldName.replace(/\.js$/, `-${to.replace(/\W/g, '')}.js`);
  for (const f of files) {
    const text = readFileSync(f, 'utf8').split(oldName).join(newName);
    writeFileSync(f, f === holder ? withVersion(text, to) : text);
  }
  renameSync(holder, holder.replace(oldName, newName));
  // Содержимое index.html изменилось — меняется и ревизия в манифесте precache.
  const sw = join(out, 'sw.js');
  writeFileSync(
    sw,
    readFileSync(sw, 'utf8').replace(/("revision":")[^"]*(","url":"index\.html")/, `$1${to}$2`) + `\n// ${to}\n`,
  );
  return out;
}

/** Статический сервер: каталог можно подменять на лету (`serve.dir = …`), `/api` проксируется на мок бэкенда. */
export async function serveVariants(backend: string, dir: string) {
  const state = { dir };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      try {
        const upstream = await fetch(`${backend}${url.pathname}${url.search}`, {
          body: body ? new Uint8Array(body) : undefined,
          headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host') as [string, string][]),
          method: req.method,
        });
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.writeHead(502).end();
      }
      return;
    }
    let file = join(state.dir, url.pathname === '/' ? 'index.html' : url.pathname);
    try {
      if (!statSync(file).isFile()) throw new Error();
    } catch {
      file = join(state.dir, 'index.html');
    }
    res.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    });
    res.end(readFileSync(file));
  });
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return {
    close: () => new Promise<void>(r => void server.close(() => r())),
    set dir(d: string) {
      state.dir = d;
    },
    url: `http://localhost:${port}`,
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise(resolveBody => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
  });
}
