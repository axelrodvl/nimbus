import { defineConfig, devices } from '@playwright/test';

const mockPort = Number(process.env.MOCK_BACKEND_PORT ?? 4011);
const previewPort = 4173;

export default defineConfig({
  forbidOnly: !!process.env.CI,
  // Мок бэкенда общий и хранит состояние: тесты идут по одному и сбрасывают его через /__test/reset.
  fullyParallel: false,
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
        // Тесты написаны под русский интерфейс.
        locale: 'ru-RU',
      },
    },
  ],
  reporter: process.env.CI ? 'github' : 'list',
  retries: process.env.CI ? 2 : 0,
  testDir: './tests/e2e',
  use: { baseURL: `http://localhost:${previewPort}`, trace: 'on-first-retry' },
  // Сборка + vite preview с прокси /api на мок бэкенда.
  webServer: [
    {
      command: 'bun tests/mock-backend.ts',
      env: { MOCK_BACKEND_PORT: String(mockPort) },
      reuseExistingServer: !process.env.CI,
      url: `http://localhost:${mockPort}/api/health`,
    },
    {
      command: `bun run build && bun run preview --port ${previewPort} --strictPort`,
      env: { VITE_BACKEND_URL: `http://localhost:${mockPort}` },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      url: `http://localhost:${previewPort}`,
    },
  ],
  workers: 1,
});
