import { defineConfig, devices } from '@playwright/test';

// E2E против поднятого стека (`just e2e`); webServer не нужен.
export default defineConfig({
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--autoplay-policy=no-user-gesture-required'],
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
        },
      },
    },
  ],
  reporter: 'list',
  testDir: './tests/e2e',
  timeout: 120_000,
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8010' },
  workers: 1,
});
