import { expect, test, type Page } from '@playwright/test';

const MOCK = `http://localhost:${process.env.MOCK_BACKEND_PORT ?? 4010}`;

// Тесты меняют общее состояние мока — выполняем последовательно и сбрасываем перед каждым.
test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK}/__reset`);
});

const row = (page: Page, title: string) => page.getByTestId('track-row').filter({ hasText: title });
const log = async (page: Page) =>
  (await page.request.get(`${MOCK}/__log`)).json() as Promise<Array<{ method: string; path: string; body?: unknown }>>;

async function openSourceDialog(page: Page, title: string) {
  await row(page, title)
    .getByRole('button', { name: /Действия/ })
    .click();
  await page.getByRole('menuitem', { name: 'Выбрать источник' }).click();
  return page.getByRole('dialog', { name: /Источник трека/ });
}

test('значок «проверьте» у сомнительного primary в строке и в шапке', async ({ page }) => {
  await page.goto('/album/104');
  await expect(row(page, 'Doubtful Song').getByTestId('needs-confirmation')).toBeVisible();
  await expect(row(page, 'Missing Song').getByTestId('needs-confirmation')).toHaveCount(0);
  await expect(page.getByTestId('album-needs-confirmation')).toBeVisible();
});

test('диалог источника: подтверждение сомнительного', async ({ page }) => {
  await page.goto('/album/104');
  const dialog = await openSourceDialog(page, 'Doubtful Song');
  const items = dialog.getByTestId('source-item');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveAttribute('data-primary', 'true');
  await expect(items.first()).toContainText('проверьте');
  await items.first().getByRole('button', { name: 'Подтвердить' }).click();
  await expect(items.first()).not.toContainText('проверьте');
  expect((await log(page)).some(r => r.path === '/api/tracks/1041/sources/1/confirm')).toBe(true);
});

test('выбор другого источника отправляет PUT с source_id', async ({ page }) => {
  await page.goto('/album/104');
  const dialog = await openSourceDialog(page, 'Doubtful Song');
  await dialog.getByTestId('source-item').nth(1).getByRole('button', { name: 'Выбрать' }).click();
  await expect(dialog).toBeHidden();
  const put = (await log(page)).find(r => r.method === 'PUT');
  expect(put).toMatchObject({ body: { source_id: 2 }, path: '/api/tracks/1041/source' });
});

test('ручной выбор файла: PUT с torrent_id и file_index, статус not_found → found', async ({ page }) => {
  await page.goto('/album/104');
  const missing = row(page, 'Missing Song');
  await expect(missing.getByRole('img', { name: 'Трек не найден в раздачах' })).toBeVisible();
  const dialog = await openSourceDialog(page, 'Missing Song');
  await dialog.getByRole('button', { name: 'Выбрать файл вручную' }).click();
  await dialog.getByRole('button', { name: /Sources Test \[FLAC\]/ }).click();
  await dialog.getByRole('button', { name: /03 Missing Song\.flac/ }).click();
  await expect(dialog).toBeHidden();
  const put = (await log(page)).find(r => r.method === 'PUT');
  expect(put).toMatchObject({ body: { file_index: 2, torrent_id: 900 }, path: '/api/tracks/1042/source' });
  await expect(missing.getByRole('img', { name: 'Найдено, можно слушать' })).toBeVisible();
});

test('«Повторить поиск» в меню not_found-трека', async ({ page }) => {
  await page.goto('/album/104');
  await row(page, 'Retry Song')
    .getByRole('button', { name: /Действия/ })
    .click();
  await page.getByRole('menuitem', { name: 'Повторить поиск' }).click();
  await expect.poll(async () => (await log(page)).some(r => r.path === '/api/tracks/1043/retry')).toBe(true);
});

test('страница источников: раздачи, файлы с пометками, retry и magnet', async ({ page }) => {
  await page.goto('/album/104');
  await page.getByRole('link', { name: 'Источники' }).click();
  await expect(page).toHaveURL(/\/album\/104\/sources$/);
  const item = page.getByTestId('torrent-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('TPB');
  await expect(item).toContainText('Sources Test [FLAC]');
  await expect(item).toContainText('1 тр.');

  await item.getByRole('button').first().click();
  const files = page.getByTestId('torrent-file');
  await expect(files).toHaveCount(3);
  await expect(files.first()).toContainText('Doubtful Song');

  await page.getByRole('button', { name: 'Повторить поиск' }).click();
  await expect.poll(async () => (await log(page)).some(r => r.path === '/api/albums/104/retry')).toBe(true);

  const input = page.getByLabel('Magnet-ссылка');
  await input.fill('not a magnet');
  await page.getByRole('button', { name: 'Добавить magnet' }).click();
  await expect(page.getByText('Это не magnet-ссылка')).toBeVisible();
  await input.fill('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x');
  await page.getByRole('button', { name: 'Добавить magnet' }).click();
  await expect(page.getByTestId('torrent-item')).toHaveCount(2);
});
