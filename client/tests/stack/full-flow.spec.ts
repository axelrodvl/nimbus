import { expect, test, type Page } from '@playwright/test';

// Сквозной сценарий на полном стеке (`just e2e`): настоящий бэкенд в Docker с фейковыми внешними сервисами
// (MusicBrainz, трекер, локальный сидер) и SPA, которую он сам раздаёт. Один origin, без прокси.

const token = process.env.E2E_TOKEN ?? 'e2e-token';

async function openPalette(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  return dialog;
}

const firstRow = (page: Page) => page.getByTestId('track-row').first();
const firstStatus = (page: Page) => firstRow(page).locator('[data-status]');
const audioTime = (page: Page) =>
  page.evaluate(() => (document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).currentTime);

test('вход → поиск → добавление → треки найдены → воспроизведение → на сервер → на устройство → без сети', async ({
  context,
  page,
  request,
}) => {
  // Бэкенд раздаёт SPA и без токена; API закрыт.
  expect((await request.get('/api/settings')).status()).toBe(401);
  expect((await request.get('/', { headers: { accept: 'text/html' } })).status()).toBe(200);
  // Отсутствующий скрипт — честный 404, а не index.html.
  expect((await request.get('/assets/missing.js')).status()).toBe(404);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Токен доступа').fill('wrong');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByText('Неверный токен')).toBeVisible();
  await page.getByLabel('Токен доступа').fill(token);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/);

  // ⌘K → поиск → страница результатов.
  const dialog = await openPalette(page);
  await dialog.getByRole('combobox').fill('radiohead');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=radiohead/);

  const card = page.getByTestId('remote-album').filter({ hasText: 'OK Computer' }).first();
  await card.getByRole('button', { name: 'Добавить в библиотеку' }).click();
  // Дельта синхронизации принесла альбом: кнопка превратилась в отметку «в библиотеке» (ссылки «Открыть» нет).
  await expect(card.getByText('В библиотеке')).toBeVisible();
  await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
  await page.getByTestId('library-albums').getByRole('link', { name: /OK Computer/ }).click();
  await expect(page.getByRole('heading', { name: 'OK Computer' })).toBeVisible();

  // Статус трека приходит по WebSocket без перезагрузки (фейковые провайдеры нашли торрент).
  await expect(firstStatus(page)).toHaveAttribute('data-status', /found|ready/, { timeout: 90_000 });

  await firstRow(page)
    .getByRole('button', { name: /^Играть:/ })
    .click();
  await expect.poll(() => audioTime(page), { timeout: 60_000 }).toBeGreaterThan(1);
  await expect(firstStatus(page)).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });

  // Закрепить на сервере: торрент докачивается целиком.
  await page.getByTestId('server-download').click();
  await expect(page.getByTestId('server-download-done')).toHaveText('На сервере', { timeout: 120_000 });

  // Скачать на устройство (OPFS).
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const offline = page.getByTestId('offline-control').getByTestId('offline-button');
  await offline.click();
  await expect(offline).toHaveAttribute('data-state', 'done', { timeout: 120_000 });

  // Без сети: оболочка из кэша service worker, трек играет из файла на устройстве.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'OK Computer' })).toBeVisible();
  const streams: string[] = [];
  page.on('request', r => {
    if (/\/api\/tracks\/\d+\/stream/.test(r.url())) streams.push(r.url());
  });
  await page.getByTestId('play-album').first().click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const a = document.querySelector('[data-testid=player-audio]') as HTMLAudioElement;
        return !a.paused && a.currentTime > 0.5 && (a.currentSrc || a.src).startsWith('blob:');
      }),
    )
    .toBe(true);
  expect(streams).toEqual([]);
});
