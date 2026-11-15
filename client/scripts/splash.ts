// Заставки iOS (`apple-touch-startup-image`): размеры устройств, имена файлов и блок `<link>` для `index.html`.
// Сами PNG рисует `scripts/gen-splash.ts` из `public/logo.svg` (`bun run gen:splash`); тест сверяет `index.html` с этим списком.

export type SplashSize = { width: number; height: number; ratio: number };

/** Портретные размеры в CSS-пикселях и коэффициент плотности: актуальные iPhone и iPad. */
export const SPLASH_SIZES: SplashSize[] = [
  { height: 932, ratio: 3, width: 430 },
  { height: 852, ratio: 3, width: 393 },
  { height: 926, ratio: 3, width: 428 },
  { height: 844, ratio: 3, width: 390 },
  { height: 812, ratio: 3, width: 375 },
  { height: 896, ratio: 3, width: 414 },
  { height: 896, ratio: 2, width: 414 },
  { height: 667, ratio: 2, width: 375 },
  { height: 736, ratio: 3, width: 414 },
  { height: 1366, ratio: 2, width: 1024 },
  { height: 1194, ratio: 2, width: 834 },
  { height: 1180, ratio: 2, width: 820 },
  { height: 1112, ratio: 2, width: 834 },
  { height: 1080, ratio: 2, width: 810 },
];

export const SPLASH_THEMES = {
  dark: { background: '#121212' },
  light: { background: '#fafafa' },
} as const;
export type SplashTheme = keyof typeof SPLASH_THEMES;

export const splashFile = (s: SplashSize, theme: SplashTheme): string =>
  `splash/${theme}-${s.width * s.ratio}x${s.height * s.ratio}.png`;

export const SPLASH_START = '<!-- splash:start (сгенерировано scripts/splash.ts, не править руками) -->';
export const SPLASH_END = '<!-- splash:end -->';

export function splashLinks(): string {
  const lines: string[] = [];
  for (const theme of Object.keys(SPLASH_THEMES) as SplashTheme[]) {
    for (const s of SPLASH_SIZES) {
      const media = `(device-width: ${s.width}px) and (device-height: ${s.height}px) and (-webkit-device-pixel-ratio: ${s.ratio}) and (orientation: portrait) and (prefers-color-scheme: ${theme})`;
      lines.push(`    <link rel="apple-touch-startup-image" href="/${splashFile(s, theme)}" media="${media}" />`);
    }
  }
  return [`    ${SPLASH_START}`, ...lines, `    ${SPLASH_END}`].join('\n');
}

/** Подставляет актуальный блок ссылок в `index.html`. */
export function withSplashLinks(html: string): string {
  const a = html.indexOf(SPLASH_START);
  const b = html.indexOf(SPLASH_END);
  if (a < 0 || b < 0) throw new Error('index.html: нет маркеров splash:start/splash:end');
  return html.slice(0, html.lastIndexOf('\n', a) + 1) + splashLinks() + html.slice(b + SPLASH_END.length);
}
