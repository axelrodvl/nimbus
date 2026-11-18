import { expect, test, type Page } from '@playwright/test';
import { resetMock, seedSources } from './mock';

const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
const HEX = '0123456789abcdef0123456789abcdef01234567';

test.beforeEach(async ({ request }) => {
  await resetMock(request);
  await seedSources(request);
});

test('страница источников: раздачи в таблице, добавление magnet — новая строка', async ({ page }) => {
  await page.goto('/album/913');
  await waitSynced(page);
  await page.getByTestId('album-menu').click();
  await page.getByTestId('album-sources-link').click();
  await expect(page).toHaveURL(/\/album\/913\/sources$/);
  await expect(page.getByTestId('torrent-item')).toHaveCount(2);

  const field = page.getByRole('textbox', { name: 'Magnet-ссылка' });
  await field.fill('magnet:?dn=no-hash');
  await expect(page.getByTestId('magnet-error')).toHaveText('Это не magnet-ссылка');
  await expect(page.getByRole('button', { name: 'Добавить magnet' })).toBeDisabled();

  await field.fill(`magnet:?xt=urn:btih:${HEX}&dn=Mine`);
  await page.getByRole('button', { name: 'Добавить magnet' }).click();
  await expect(page.getByTestId('torrent-item')).toHaveCount(3);
  await expect(page.getByTestId('torrent-item').last()).toContainText('Свой');
  await expect(field).toHaveValue('');
});

test('раздача раскрывается и показывает файлы', async ({ page }) => {
  await page.goto('/album/913/sources');
  await page.getByTestId('torrent-item').first().getByRole('button').click();
  await expect(page.getByTestId('torrent-file')).toHaveCount(3);
});

test('выбор раздачи для альбома: форматы, подтверждение, пометка «Используется» переезжает', async ({ page }) => {
  await page.goto('/album/913/sources');
  const items = page.getByTestId('torrent-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).getByTestId('torrent-formats')).toHaveText('FLAC');
  await expect(items.nth(1).getByTestId('torrent-formats')).toHaveText('MP3');
  await expect(items.nth(0).getByTestId('torrent-in-use')).toBeVisible();
  await expect(items.nth(1).getByTestId('torrent-in-use')).toHaveCount(0);

  await items.nth(1).locator('button[aria-expanded]').click();
  await items.nth(1).getByTestId('use-torrent').click();
  const dialog = page.getByRole('dialog', { name: 'Перевести альбом на эту раздачу?' });
  await dialog.getByRole('button', { name: 'Использовать для альбома' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Треков переведено на раздачу/).first()).toBeVisible();
  await expect(items.nth(1).getByTestId('torrent-in-use')).toBeVisible();
  await expect(items.nth(0).getByTestId('torrent-in-use')).toHaveCount(0);
});

test('«Повторить поиск» на странице источников: ненайденные треки переходят в adding', async ({ page }) => {
  await page.goto('/album/913');
  await waitSynced(page);
  const lost = page.locator('[data-track-id="9133"]');
  await expect(lost.locator('[data-status]').first()).toHaveAttribute('data-status', 'not_found');
  await page.getByTestId('album-menu').click();
  await page.getByTestId('album-sources-link').click();
  await page.getByTestId('retry-album').click();
  await expect(page.getByText('Поиск запущен заново').first()).toBeVisible();
  await page.getByRole('link', { name: /Sources Test/ }).click();
  await expect(page.locator('[data-track-id="9133"] [data-status]').first()).toHaveAttribute('data-status', 'adding');
});

test('сменить источник трека в диалоге — бейдж «проверьте» исчезает', async ({ page }) => {
  await page.goto('/album/913');
  await waitSynced(page);
  const row = page.locator('[data-track-id="9132"]');
  await expect(row.getByTestId('needs-confirmation')).toBeVisible();
  await row.getByTestId('needs-confirmation').click();
  const dialog = page.getByRole('dialog', { name: /Источник трека/ });
  await expect(dialog.getByTestId('source-item')).toHaveCount(2);
  await expect(dialog.getByTestId('source-item').first()).toHaveAttribute('data-primary', 'true');
  await expect(dialog.getByTestId('source-needs-check')).toBeVisible();
  await dialog.getByTestId('source-item').nth(1).getByRole('button', { name: 'Выбрать' }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByTestId('needs-confirmation')).toHaveCount(0);
});

test('подтверждение сомнительного источника убирает бейдж', async ({ page }) => {
  await page.goto('/album/913');
  await waitSynced(page);
  const row = page.locator('[data-track-id="9132"]');
  await row.getByTestId('track-menu').click();
  await page.getByRole('menuitem', { name: 'Выбрать источник' }).click();
  const dialog = page.getByRole('dialog', { name: /Источник трека/ });
  await dialog.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(dialog.getByTestId('source-needs-check')).toHaveCount(0);
  await expect(row.getByTestId('needs-confirmation')).toHaveCount(0);
});

test('выбор файла вручную: раздача → файл', async ({ page }) => {
  await page.goto('/album/913');
  await waitSynced(page);
  await page.locator('[data-track-id="9131"]').getByTestId('track-menu').click();
  await page.getByRole('menuitem', { name: 'Выбрать источник' }).click();
  const dialog = page.getByRole('dialog', { name: /Источник трека/ });
  await dialog.getByRole('button', { name: 'Выбрать файл вручную' }).click();
  await dialog.getByTestId('dialog-torrent').first().click();
  await dialog.getByTestId('dialog-file').nth(1).click();
  await expect(page.getByText('Источник выбран').first()).toBeVisible();
  await expect(dialog).toBeHidden();
});

test('повтор поиска трека из меню ненайденного', async ({ page }) => {
  await page.goto('/album/913');
  await waitSynced(page);
  await page.locator('[data-track-id="9133"]').getByTestId('track-menu').click();
  await page.getByRole('menuitem', { name: 'Повторить поиск' }).click();
  await expect(page.locator('[data-track-id="9133"] [data-status]').first()).toHaveAttribute('data-status', 'adding');
});

test('мобильная ширина: раздачи без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 390 });
  await page.goto('/album/913/sources');
  await expect(page.getByTestId('torrent-item')).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
