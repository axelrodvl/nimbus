// Матрица скриншотов (шаг 49): каждый экран × светлая/тёмная тема × ширины 360/768/1440, плюс de/ja на 360 для плотных экранов.
// Результат — client/test-results/audit/<экран>-<тема>-<ширина>.png (в git не коммитится). Это инструмент аудита, не эталоны.
import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { openScreen, SCREENS } from './screens';

const OUT = 'test-results/audit';
const WIDTHS = [360, 768, 1440] as const;
const THEMES = ['light', 'dark'] as const;
const heights: Record<number, number> = { 1440: 900, 360: 800, 768: 1024 };

mkdirSync(OUT, { recursive: true });

for (const screen of SCREENS) {
  const variants = [
    ...THEMES.flatMap(theme => WIDTHS.map(width => ({ lang: 'en', theme, width }))),
    ...(screen.dense ? (['de', 'ja'] as const).map(lang => ({ lang, theme: 'dark' as const, width: 360 })) : []),
  ];
  for (const v of variants) {
    test(`${screen.name} · ${v.lang} · ${v.theme} · ${v.width}`, async ({ browser, request }) => {
      const context = await browser.newContext({
        locale: v.lang === 'ja' ? 'ja-JP' : v.lang === 'de' ? 'de-DE' : 'en-US',
        viewport: { height: heights[v.width] ?? 900, width: v.width },
      });
      await context.addInitScript(
        ([theme, lang]) => {
          localStorage.setItem('nimbus:theme', theme as string);
          localStorage.setItem('nimbus:locale', lang as string);
        },
        [v.theme, v.lang],
      );
      const page = await context.newPage();
      try {
        await openScreen(screen, { page, request }, () => context.setOffline(true));
        const suffix = v.lang === 'en' ? '' : `-${v.lang}`;
        await page.screenshot({ path: `${OUT}/${screen.name}${suffix}-${v.theme}-${v.width}.png` });
      } finally {
        await context.close();
      }
    });
  }
}
