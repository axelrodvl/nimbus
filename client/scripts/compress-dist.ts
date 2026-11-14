// Предсжатие сборки: рядом с каждым текстовым файлом кладёт `.br` и `.gz`, бэкенд отдаёт их по Accept-Encoding
// (tower-http `precompressed_*`). Запускается после `vite build` (service worker уже собран).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const DIST = process.argv[2] ?? 'dist';
const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|webmanifest|txt|map)$/;
const MIN_SIZE = 1024;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

let files = 0;
let before = 0;
let after = 0;
for (const path of walk(DIST)) {
  if (!COMPRESSIBLE.test(path) || statSync(path).size < MIN_SIZE) continue;
  const raw = readFileSync(path);
  const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(`${path}.br`, br);
  writeFileSync(`${path}.gz`, gzipSync(raw, { level: 9 }));
  files += 1;
  before += raw.length;
  after += br.length;
}
// eslint-disable-next-line no-console -- сценарий сборки, вывод в терминал
console.log(`compress-dist: ${files} files, ${(before / 1024).toFixed(0)} KiB → br ${(after / 1024).toFixed(0)} KiB`);
