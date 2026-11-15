import { defineConfig, devices } from '@playwright/test';

// Нагрузка, отказы и длительный прогон на полном стеке (`just load`, `just resilience`, `just soak`); не входят в CI по умолчанию.
// Стек (проект `nimbus-load`, порт 8011) поднимает scripts/load.sh.
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
        locale: 'ru-RU',
      },
    },
  ],
  reporter: 'list',
  testDir: './tests/stack',
  testMatch: process.env.LOAD_SPEC ?? 'load.spec.ts',
  timeout: 45 * 60_000,
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8011' },
  workers: 1,
});
