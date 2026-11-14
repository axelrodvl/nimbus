import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    coverage: {
      exclude: ['src/lib/api/schema.d.ts', 'src/main.tsx', 'src/test/**', 'src/lib/i18n/messages/**', 'src/**/*.test.*'],
      include: ['src/**'],
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      // Храповик: пороги только растут.
      thresholds: { lines: 95, 'src/lib/**': { lines: 97 } },
    },
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
