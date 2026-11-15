import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialAssets } from '../../scripts/bundle-lib';

const budget = JSON.parse(readFileSync(join(__dirname, '..', '..', 'bundle-budget.json'), 'utf8')) as {
  css_gzip_bytes: number;
  js_gzip_bytes: number;
};

describe('бюджет размера сборки', () => {
  it('начальные файлы: скрипт-модуль, modulepreload и стили из index.html; динамические чанки не считаются', () => {
    const html = `<head>
      <script src="/theme-init.js"></script>
      <script type="module" crossorigin src="/assets/index-A.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/vendor-B.js">
      <link rel="stylesheet" crossorigin href="/assets/index-C.css">
      <link rel="icon" href="/icons/icon.svg">
      <link rel="manifest" href="/manifest.webmanifest"></head>`;
    expect(initialAssets(html)).toEqual({
      css: ['/assets/index-C.css'],
      js: ['/assets/index-A.js', '/assets/vendor-B.js'],
    });
  });

  it('порог не выше целей шага 49 (JS 350 КБ, CSS 40 КБ gzip): храповик только вниз', () => {
    expect(budget.js_gzip_bytes).toBeLessThanOrEqual(350 * 1024);
    expect(budget.css_gzip_bytes).toBeLessThanOrEqual(40 * 1024);
  });
});
