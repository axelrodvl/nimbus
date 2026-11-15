// Рисует заставки iOS в `public/splash/` (Chromium из Playwright) и обновляет блок ссылок в `index.html`.
// Запуск: `bun run gen:splash`. PNG коммитятся; отдельного шага сборки это не требует.
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SPLASH_SIZES, SPLASH_THEMES, splashFile, withSplashLinks, type SplashTheme } from './splash';

const root = fileURLToPath(new URL('..', import.meta.url));
const logo = await readFile(`${root}public/logo.svg`, 'utf8');
await mkdir(`${root}public/splash`, { recursive: true });

const browser = await chromium.launch();
try {
  for (const theme of Object.keys(SPLASH_THEMES) as SplashTheme[]) {
    for (const size of SPLASH_SIZES) {
      const page = await browser.newPage({
        deviceScaleFactor: size.ratio,
        viewport: { height: size.height, width: size.width },
      });
      // Логотип — 22 % короткой стороны, по центру.
      const side = Math.round(Math.min(size.width, size.height) * 0.22);
      await page.setContent(
        `<body style="margin:0;background:${SPLASH_THEMES[theme].background};display:grid;place-items:center;height:100vh">` +
          `<div style="width:${side}px;height:${side}px">${logo.replace(/width="96" height="96"/, 'width="100%" height="100%"')}</div></body>`,
      );
      await page.screenshot({ path: `${root}public/${splashFile(size, theme)}` });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
const indexPath = `${root}index.html`;
await writeFile(indexPath, withSplashLinks(await readFile(indexPath, 'utf8')));
