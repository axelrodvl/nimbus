import { defineConfig } from '@playwright/test';
import { chromiumUse, previewPort, webServer } from './playwright.shared';

// Бюджеты производительности (шаг 49), `just client-perf`: большая библиотека на моке, медиана из нескольких повторов.
export default defineConfig({
  fullyParallel: false,
  outputDir: 'test-results/perf-run',
  projects: [{ name: 'chromium', use: chromiumUse }],
  reporter: 'list',
  retries: 0,
  testDir: './tests/perf',
  timeout: 240_000,
  use: { baseURL: `http://localhost:${previewPort}`, trace: 'off' },
  webServer,
  workers: 1,
});
