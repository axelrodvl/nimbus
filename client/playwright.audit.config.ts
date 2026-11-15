import { defineConfig } from '@playwright/test';
import { chromiumUse, previewPort, webServer } from './playwright.shared';

// Аудит интерфейса (шаг 49): матрица скриншотов, axe, клавиатура. Не входит в `test:e2e`; запуск — `just client-audit`.
// WebKit: `AUDIT_WEBKIT=1` добавляет проект webkit (если браузер установлен).
export default defineConfig({
  fullyParallel: false,
  outputDir: 'test-results/audit-run',
  projects: [
    { name: 'chromium', use: chromiumUse },
    ...(process.env.AUDIT_WEBKIT ? [{ name: 'webkit', use: { browserName: 'webkit' as const, locale: 'en-US' } }] : []),
  ],
  reporter: 'list',
  testDir: './tests/audit',
  timeout: 120_000,
  use: { baseURL: `http://localhost:${previewPort}`, trace: 'off' },
  webServer,
  workers: 1,
});
