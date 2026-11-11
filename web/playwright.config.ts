import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3002';
const { port } = new URL(baseURL);
const mockPort = Number(process.env.MOCK_BACKEND_PORT ?? 4010);
const mockUrl = `http://localhost:${mockPort}`;

export default defineConfig({
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Если нужная версия Chromium не установлена, можно указать готовый бинарник.
        launchOptions: {
          args: ['--autoplay-policy=no-user-gesture-required'],
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
        },
      },
    },
  ],
  reporter: 'html',
  retries: process.env.CI ? 2 : 0,
  testDir: './tests',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  // Мок бэкенда (серверные компоненты ходят на BACKEND_URL с сервера, page.route их не видит)
  // и dev-сервер Next, направленный на него.
  webServer: [
    {
      command: 'node tests/mock-backend.mjs',
      env: { MOCK_BACKEND_PORT: String(mockPort) },
      reuseExistingServer: true,
      url: `${mockUrl}/api/health`,
    },
    {
      command: `pnpm dev --port ${port}`,
      env: { BACKEND_URL: mockUrl, NEXT_PUBLIC_BACKEND_URL: mockUrl },
      reuseExistingServer: true,
      stdout: 'pipe',
      url: baseURL,
    },
  ],
  workers: process.env.CI ? 1 : undefined,
});
