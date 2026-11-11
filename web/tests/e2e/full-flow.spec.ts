import { expect, test, type Page } from '@playwright/test';

const token = process.env.E2E_TOKEN ?? 'e2e-token';
// За caddy API на том же origin; при ручном запуске без прокси укажите E2E_API_URL.
const apiBase = process.env.E2E_API_URL ?? '';

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

test('логин → поиск → добавление → воспроизведение → ready', async ({ page, request }) => {
  // Без логина API закрыт.
  expect((await request.get(`${apiBase}/api/settings`)).status()).toBe(401);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
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

  const albums = page.locator('section[aria-labelledby="search-albums"]');
  await albums.getByRole('button', { name: 'Добавить в библиотеку' }).first().click();
  await expect(albums.getByRole('button', { name: 'Добавлено в библиотеку' }).first()).toBeVisible();

  await page.goto('/library?tab=albums');
  await page
    .getByTestId('library-albums')
    .getByRole('link', { name: /OK Computer/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'OK Computer' })).toBeVisible();

  // Статус приходит по WebSocket без перезагрузки.
  await expect(firstStatus(page)).toHaveAttribute('data-status', /found|ready/, { timeout: 90_000 });

  await firstRow(page).getByRole('button', { name: /^Играть:/ }).click();
  await expect
    .poll(() => page.evaluate(() => (document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).currentTime), {
      timeout: 60_000,
    })
    .toBeGreaterThan(1);

  await expect(firstStatus(page)).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });
  await page.reload();
  await expect(firstStatus(page)).toHaveAttribute('data-status', 'ready');
});
