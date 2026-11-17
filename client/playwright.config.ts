import { defineConfig, devices } from '@playwright/test';

const mockPort = Number(process.env.MOCK_BACKEND_PORT ?? 4011);
const previewPort = 4173;

// GPU выключен: в WSL/контейнерах инициализация GPU-процесса Chromium задерживает первый кадр на 10–100 с, а Playwright
// ждёт кадра (rAF) в проверке «элемент стабилен» — клики падали по таймауту (см. playwright.load.config.ts, C13).
const noGpuArgs = ['--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer'];

export default defineConfig({
  forbidOnly: !!process.env.CI,
  // Мок бэкенда общий и хранит состояние: тесты идут по одному и сбрасывают его через /__test/reset.
  fullyParallel: false,
  projects: [
    {
      name: 'chromium',
      testIgnore: /mobile\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        // Автозапуск звука без жеста пользователя — как в старом конфиге.
        launchOptions: {
          args: ['--autoplay-policy=no-user-gesture-required', ...noGpuArgs],
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
        },
        // Тесты написаны под русский интерфейс.
        locale: 'ru-RU',
      },
    },
    // Мобильные сценарии шага 50: эмуляция устройств. WebKit в среде разработки не установлен, поэтому iPhone —
    // Chromium с тем же viewport, UA и сенсорным вводом (сценарии, зависящие от движка, помечены в самих тестах).
    {
      name: 'mobile-android',
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['Pixel 7'], launchOptions: { args: noGpuArgs }, locale: 'ru-RU' },
    },
    {
      name: 'mobile-ios',
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['iPhone 15'], browserName: 'chromium', launchOptions: { args: noGpuArgs }, locale: 'ru-RU' },
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
      env: { VITE_BACKEND_URL: `http://localhost:${mockPort}`, VITE_UI_GALLERY: '1' },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      url: `http://localhost:${previewPort}`,
    },
  ],
  workers: 1,
});
