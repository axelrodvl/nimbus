// Бюджет размера сборки: начальный JS (то, что грузит index.html до первого экрана) и CSS в gzip.
// Пороги — `bundle-budget.json` (храповик: только вниз; после шага — фактическое + 5 %). Запуск после `vite build`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { initialAssets } from './bundle-lib';

const DIST = process.argv[2] ?? 'dist';
const budget = JSON.parse(readFileSync(new URL('../bundle-budget.json', import.meta.url), 'utf8')) as {
  css_gzip_bytes: number;
  js_gzip_bytes: number;
};

const gzipSize = (file: string) => gzipSync(readFileSync(join(DIST, file)), { level: 9 }).length;
const total = (files: string[]) => files.reduce((sum, f) => sum + gzipSize(f), 0);

const assets = initialAssets(readFileSync(join(DIST, 'index.html'), 'utf8'));
const js = total(assets.js);
const css = total(assets.css);
const kb = (n: number) => `${(n / 1024).toFixed(1)} КБ`;

// eslint-disable-next-line no-console -- сценарий сборки, вывод в терминал
console.log(
  `Начальный JS: ${kb(js)} gzip (порог ${kb(budget.js_gzip_bytes)}), CSS: ${kb(css)} (порог ${kb(budget.css_gzip_bytes)})`,
);
if (js > budget.js_gzip_bytes || css > budget.css_gzip_bytes) {
  // eslint-disable-next-line no-console -- сценарий сборки, вывод в терминал
  console.error(
    'Бюджет размера сборки превышен: см. отчёт (rollup-plugin-visualizer), дубли зависимостей, чанки словарей.',
  );
  process.exit(1);
}

// Галерея примитивов `/dev/ui` не должна попадать в боевую сборку (в e2e-сборке она включена `VITE_UI_GALLERY=1`).
if (process.env.VITE_UI_GALLERY !== '1') {
  const leaked = readdirSync(join(DIST, 'assets'))
    .filter(f => f.endsWith('.js'))
    .filter(f => readFileSync(join(DIST, 'assets', f), 'utf8').includes('/dev/ui'));
  if (leaked.length > 0) {
    // eslint-disable-next-line no-console -- сценарий сборки, вывод в терминал
    console.error(`Маршрут /dev/ui попал в боевую сборку: ${leaked.join(', ')}`);
    process.exit(1);
  }
}
