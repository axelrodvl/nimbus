import { defineConfig, devices } from '@playwright/test';

// E2E против поднятого полного стека в Docker (`just e2e`); webServer не нужен.
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
        // Сценарий написан под русский интерфейс.
        locale: 'ru-RU',
      },
    },
  ],
  reporter: 'list',
  testDir: './tests/stack',
  // Нагрузка/отказы/soak идут отдельно (playwright.load.config.ts).
  testMatch: 'full-flow.spec.ts',
  timeout: 240_000,
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8010' },
  workers: 1,
});
