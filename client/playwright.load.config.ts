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
          // GPU выключен: в WSL/контейнерах инициализация GPU-процесса Chromium задерживает первый кадр на 10–100 с, а
          // Playwright ждёт кадра (rAF) в проверке «элемент стабилен» — клик по «Войти» падал по таймауту 20 с (C13).
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--disable-gpu',
            '--disable-gpu-compositing',
            '--disable-software-rasterizer',
          ],
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
  use: { actionTimeout: 20_000, baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8011' },
  workers: 1,
});
