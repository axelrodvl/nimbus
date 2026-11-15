import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };
import { LOCALES } from './src/lib/i18n/config';

// Словари кроме английского (он в основном бандле) — чанки `assets/<код>-<хэш>.js`: вне precache (см. src/sw/classify.ts).
const DICTIONARY_GLOB = `assets/{${LOCALES.map(l => l.code)
  .filter(c => c !== 'en')
  .join(',')}}-*.js`;

// `/api` (включая WebSocket) уходит на бэкенд; тот же прокси — в `vite preview`.
const backend = process.env.VITE_BACKEND_URL ?? 'http://localhost:8080';
const proxy = {
  '/api': {
    changeOrigin: true,
    // Обрыв ответа бэкенда (рвётся соединение посреди тела) должен дойти до клиента: по умолчанию http-proxy оставляет
    // ответ висеть, и докачка файла (шаг 46) никогда не начиналась бы.
    configure: (p: { on(event: 'proxyRes', cb: (res: { on(e: 'aborted', cb: () => void): void }, req: unknown, clientRes: { destroy(): void }) => void): void }) =>
      p.on('proxyRes', (proxyRes, _req, clientRes) => proxyRes.on('aborted', () => clientRes.destroy())),
    target: backend,
    ws: true,
  },
};

/** Версия сборки: `package.json` + короткий git-хэш (если есть git). */
function appVersion(): string {
  try {
    const hash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return hash ? `${pkg.version}+${hash}` : pkg.version;
  } catch {
    return pkg.version;
  }
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? appVersion()) },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    VitePWA({
      // Регистрацию делает src/lib/pwa/update.ts.
      injectRegister: false,
      injectManifest: {
        // Английский словарь — в основном бандле; остальные — runtime-кэш (stale-while-revalidate).
        // Заставки iOS (public/splash) запрашивает только система при запуске — в precache им делать нечего.
        globIgnores: [DICTIONARY_GLOB, 'splash/**'],
        globPatterns: ['**/*.{js,css,html,woff2,svg,png,webmanifest}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        rollupFormat: 'iife',
      },
      // В dev SW выключен; e2e идут против сборки.
      devOptions: { enabled: false },
      filename: 'sw.js',
      manifest: {
        background_color: '#121212',
        description: 'Music player: MusicBrainz metadata, streaming from torrents',
        display: 'standalone',
        display_override: ['standalone'],
        icons: [
          { purpose: 'any', sizes: '192x192', src: '/icons/icon-192.png', type: 'image/png' },
          { purpose: 'any', sizes: '512x512', src: '/icons/icon-512.png', type: 'image/png' },
          { purpose: 'maskable', sizes: '512x512', src: '/icons/icon-maskable-512.png', type: 'image/png' },
        ],
        id: '/',
        name: 'Nimbus',
        orientation: 'any',
        scope: '/',
        short_name: 'Nimbus',
        shortcuts: [
          {
            icons: [{ sizes: '192x192', src: '/icons/icon-192.png', type: 'image/png' }],
            name: 'Search',
            short_name: 'Search',
            url: '/search',
          },
          {
            icons: [{ sizes: '192x192', src: '/icons/icon-192.png', type: 'image/png' }],
            name: 'Library',
            short_name: 'Library',
            url: '/library',
          },
        ],
        start_url: '/',
        theme_color: '#121212',
      },
      // Манифест подключается вручную в index.html (две темы — две пары meta theme-color).
      manifestFilename: 'manifest.webmanifest',
      registerType: 'prompt',
      srcDir: 'src/sw',
      strategies: 'injectManifest',
    }),
  ],
  preview: { port: 4173, proxy },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, proxy },
});
