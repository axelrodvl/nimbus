// Мобильная PWA (шаг 50): жесты, листы, возврат из фона, клавиатура, запуск. Проекты `mobile-android` (Pixel 7) и
// `mobile-ios` (iPhone 15 viewport/UA на Chromium: WebKit в среде не установлен).
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { dropWs, mockLog, resetMock, seedMock } from './mock';

const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');

/** Настоящие касания через CDP: порождают pointer-события с `pointerType: touch`. */
async function touchPath(cdp: CDPSession, points: { x: number; y: number }[], holdMs = 0) {
  const [first, ...rest] = points;
  await cdp.send('Input.dispatchTouchEvent', { touchPoints: [first], type: 'touchStart' });
  if (holdMs) await new Promise(r => setTimeout(r, holdMs));
  for (const p of rest) {
    await cdp.send('Input.dispatchTouchEvent', { touchPoints: [p], type: 'touchMove' });
    await new Promise(r => setTimeout(r, 16));
  }
  await cdp.send('Input.dispatchTouchEvent', { touchPoints: [], type: 'touchEnd' });
}

const line = (x0: number, y0: number, x1: number, y1: number, n = 12) =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n }));

test.beforeEach(async ({ request }) => resetMock(request));

test('долгое нажатие на треке открывает лист; перетаскивание вниз закрывает', async ({ page }) => {
  await page.goto('/album/1');
  await waitSynced(page);
  const row = page.getByTestId('album-tracks').getByTestId('track-row').first();
  await expect(row).toBeVisible();
  await row.evaluate(el => el.scrollIntoView({ block: 'center' }));
  // Касаемся названия (не кнопки воспроизведения и не ссылки).
  const box = (await row.locator('span.truncate').first().boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await touchPath(cdp, [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }], 700);
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-sheet', 'true');
  // Лист прижат к низу экрана.
  const sheet = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.abs(sheet.y + sheet.height - viewport.height)).toBeLessThan(2);
  // Тянем за ручку вниз.
  const handle = (await menu.getByTestId('sheet-handle').boundingBox())!;
  await touchPath(cdp, line(handle.x + handle.width / 2, handle.y + 8, handle.x + handle.width / 2, handle.y + 260));
  await expect(menu).toBeHidden();
});

test('короткое касание не открывает лист', async ({ page }) => {
  await page.goto('/album/1');
  await waitSynced(page);
  const row = page.getByTestId('album-tracks').getByTestId('track-row').first();
  const box = (await row.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await touchPath(cdp, [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }], 100);
  await page.waitForTimeout(700);
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('смахивание от левого края возвращает назад (установленное приложение iOS)', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile-ios', 'жест нужен только на iOS: на Android он системный');
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  // Переход внутри приложения (history.state.idx > 0): из библиотеки в альбом ссылкой.
  await page.goto('/library');
  const album = page.getByTestId('album-card').first();
  await album.waitFor();
  await album.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/album\/\d+/);
  await waitSynced(page);
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const h = page.viewportSize()!.height;
  await touchPath(cdp, line(4, h / 2, 220, h / 2 + 6));
  await expect(page).toHaveURL(/\/library/);
});

test('смахивание не от края не возвращает назад', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile-ios', 'жест нужен только на iOS');
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.goto('/library');
  const album = page.getByTestId('album-card').first();
  await album.waitFor();
  await album.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/album\/\d+/);
  const cdp = await page.context().newCDPSession(page);
  const h = page.viewportSize()!.height;
  await touchPath(cdp, line(120, h / 2, 330, h / 2));
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/album\/\d+/);
});

test('повторное нажатие на активную вкладку прокручивает экран к началу', async ({ page, request }) => {
  await seedMock(request, { albums: 20, artists: 5, tracks: 400 });
  await page.goto('/library');
  const main = page.locator('[data-scroll-root]');
  await expect(main).toBeVisible();
  await page.getByTestId('tab-tracks').click().catch(() => undefined);
  await page.waitForTimeout(300);
  await main.evaluate(el => {
    el.scrollTop = 800;
  });
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBeGreaterThan(300);
  await page.getByTestId('mobile-tab-bar').locator('[aria-current="page"]').click();
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBe(0);
});

test('возврат из фона: переподключение сокета и дельта синхронизации', async ({ page, request }) => {
  await page.goto('/');
  await waitSynced(page);
  await dropWs(request, false); // сервер рвёт сокеты: клиент ждёт паузу переподключения
  const before = (await mockLog(request)).filter(l => l.endsWith('/api/sync/changes')).length;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }).catch(() => undefined);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
  // Запасной путь для движков без CDP-состояний: то же событие, что шлёт браузер.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(async () => (await mockLog(request)).filter(l => l.endsWith('/api/sync/changes')).length)
    .toBeGreaterThan(before);
  await expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
});

test('поиск с открытой клавиатурой: поле видно, панели плеера и вкладок скрыты', async ({ page }) => {
  await page.goto('/search');
  await waitSynced(page);
  const input = page.getByRole('searchbox');
  await input.focus();
  // Эмуляция клавиатуры: visualViewport становится ниже окна.
  await page.evaluate(() => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, 'height', { configurable: true, value: Math.round(window.innerHeight * 0.55) });
    vv.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
  await expect(page.getByTestId('mobile-tab-bar')).toBeHidden();
  await expect(page.locator('[data-slot="player"]')).toBeHidden();
  await expect(input).toBeInViewport();
  const vvh = await page.evaluate(() => window.visualViewport!.height);
  const box = (await input.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(vvh);
});

test('запуск без белой вспышки: до загрузки стилей фон html — цвет темы', async ({ page }) => {
  await page.route('**/assets/**', () => new Promise(() => undefined)); // стили и скрипты «не загрузились»: первый кадр рисуется только инлайн-фоном из index.html
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForSelector('html');
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(bg).toBe('rgb(18, 18, 18)');
});

test('крупный текст (200 %): нет горизонтальной прокрутки на 360 px', async ({ page }) => {
  await page.setViewportSize({ height: 740, width: 360 });
  await page.addInitScript(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await page.goto('/library');
  await waitSynced(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('мета: viewport с interactive-widget, заставки iOS, display_override', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /interactive-widget=resizes-content/);
  expect(await page.locator('link[rel="apple-touch-startup-image"]').count()).toBeGreaterThanOrEqual(28);
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = (await (await request.get(new URL(href!, page.url()).toString())).json()) as Record<string, unknown>;
  expect(manifest.display_override).toEqual(['standalone']);
  expect(manifest.orientation).toBe('any');
});
