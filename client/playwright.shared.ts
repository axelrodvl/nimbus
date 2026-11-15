// Общие части конфигураций Playwright для аудита интерфейса и бюджетов производительности (шаг 49):
// тот же мок бэкенда и собранный клиент, что в `playwright.config.ts`.
import type { PlaywrightTestConfig } from '@playwright/test';
import { devices } from '@playwright/test';

export const mockPort = Number(process.env.MOCK_BACKEND_PORT ?? 4011);
export const previewPort = 4173;

export const chromiumUse = {
  ...devices['Desktop Chrome'],
  launchOptions: {
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  },
  locale: 'en-US',
};

export const webServer: PlaywrightTestConfig['webServer'] = [
  {
    command: 'bun tests/mock-backend.ts',
    env: { MOCK_BACKEND_PORT: String(mockPort) },
    reuseExistingServer: !process.env.CI,
    url: `http://localhost:${mockPort}/api/health`,
  },
  {
    command: `bun run build && bun run preview --port ${previewPort} --strictPort`,
    env: { VITE_BACKEND_URL: `http://localhost:${mockPort}`, VITE_UI_GALLERY: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    url: `http://localhost:${previewPort}`,
  },
];
