// Сверка документации с кодом (входит в `just check`):
//   1. каждый путь из client/openapi.json упомянут в docs/api.md;
//   2. каждая переменная NIMBUS_* из кода бэкенда есть в docs/operations.md и (кроме тестовых NIMBUS_FAKE_*) в .env.example;
//   3. каждая переменная из .env.example описана в docs/operations.md.
// Расхождение — ошибка (код возврата 1). Запуск: bun scripts/check-docs.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const errors: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    if (name === 'target' || name === 'node_modules') continue;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

// --- 1. OpenAPI ↔ docs/api.md
const norm = (p: string) => p.replace(/\{[^}]+\}/g, '{}').replace(/\/$/, '');
const spec = JSON.parse(read('client/openapi.json')) as { paths: Record<string, unknown> };
const documented = new Set([...read('docs/api.md').matchAll(/\/api\/[A-Za-z0-9_\-/{}.]+/g)].map(m => norm(m[0])));
for (const path of Object.keys(spec.paths)) {
  if (!documented.has(norm(path))) errors.push(`docs/api.md: нет упоминания пути ${path}`);
}

// --- 2/3. Переменные окружения
const varRe = /\bNIMBUS_[A-Z0-9_]*[A-Z0-9]\b/g;
const names = (text: string) => new Set(text.match(varRe) ?? []);
const code = new Set<string>();
for (const f of walk('backend/crates').filter(f => f.endsWith('.rs') && f.includes('/src/'))) {
  for (const v of names(read(f))) code.add(v);
}
for (const f of ['docker-compose.yml', 'deploy/docker-compose.release.yml']) for (const v of names(read(f))) code.add(v);
const env = names(read('.env.example'));
const ops = names(read('docs/operations.md'));
const testOnly = (v: string) => v.startsWith('NIMBUS_FAKE_');

for (const v of code) {
  if (!ops.has(v)) errors.push(`docs/operations.md: нет переменной ${v}`);
  if (!testOnly(v) && !env.has(v)) errors.push(`.env.example: нет переменной ${v}`);
}
for (const v of env) if (!ops.has(v)) errors.push(`docs/operations.md: нет переменной ${v} из .env.example`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`docs ok: ${Object.keys(spec.paths).length} путей API, ${code.size} переменных окружения`);
