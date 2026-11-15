import { expect, test, type Page } from '@playwright/test';
import { finishSearch, resetMock, seedAcquisition, setProgress } from './mock';

const MB = 1024 * 1024;
const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
const tab = (page: Page, id: string) => page.getByTestId(`acq-tab-link-${id}`);
const row = (page: Page, id: number) => page.getByTestId(`acq-row-${id}`);

test.beforeEach(async ({ request }) => {
  await resetMock(request);
  await seedAcquisition(request);
});

test('не найден → «Требуют внимания» с причиной → «Повторить поиск» → «В поиске» → (мок находит) → «Доступны»', async ({
  page,
  request,
}) => {
  await page.goto('/downloads');
  await waitSynced(page);
  await expect(page.getByTestId('acq-tab-attention')).toBeVisible();
  await expect(row(page, 921)).toContainText('Lost Record');
  await expect(row(page, 921).getByTestId('row-reason')).toContainText('Нет сидов');
  await expect(row(page, 922)).toContainText('Найдено 1 из 2');

  await row(page, 921).getByTestId('row-retry').click();
  await expect(page.getByText('Поставлено в очередь: 1').first()).toBeVisible();
  await expect(row(page, 921)).toHaveCount(0);
  await tab(page, 'searching').click();
  await expect(row(page, 921)).toBeVisible();

  await finishSearch(request, 921, true);
  await expect(row(page, 921)).toHaveCount(0);
  await tab(page, 'available').click();
  await expect(row(page, 921)).toBeVisible();
});

test('«Повторить для всех» обнуляет счётчик вкладки, значок в навигации исчезает', async ({ page, request }) => {
  await page.goto('/downloads');
  await waitSynced(page);
  const badge = page.getByTestId('nav-badge-downloads').first();
  await expect(badge).toHaveText('2');
  await expect(tab(page, 'attention')).toContainText('2');
  await page.getByTestId('retry-all').click();
  await expect(page.getByText('Поставлено в очередь: 2').first()).toBeVisible();
  await expect(tab(page, 'attention')).toContainText('0');
  await expect(page.getByTestId('nav-badge-downloads')).toHaveCount(0);
  await expect(tab(page, 'searching')).toContainText('3');
  await finishSearch(request, 921, true);
});

test('«Скачать на сервер» на экране альбома: прогресс растёт, затем «На сервере»; на экране загрузок — «Загружаются» → «Скачаны»', async ({
  page,
  request,
}) => {
  await page.goto('/album/923');
  await waitSynced(page);
  await page.getByTestId('server-download').click();
  await expect(page.getByTestId('server-download-progress')).toBeVisible();

  await setProgress(request, 923, 30 * MB);
  await expect(page.getByTestId('server-download-progress')).toContainText('30%');
  await setProgress(request, 923, 60 * MB);
  await expect(page.getByTestId('server-download-progress')).toContainText('60%');

  await page.goto('/downloads/downloading');
  await expect(row(page, 923)).toContainText('60%');
  await setProgress(request, 923, 100 * MB);
  await expect(row(page, 923)).toHaveCount(0);
  await tab(page, 'downloaded').click();
  await expect(row(page, 923)).toBeVisible();

  await page.goto('/album/923');
  await expect(page.getByTestId('server-download-done')).toHaveText('На сервере');
  await page.getByTestId('server-download-menu').click();
  await page.getByTestId('menu-remove').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Убрать с сервера' }).click();
  await expect(page.getByTestId('server-download')).toHaveText('Скачать на сервер');
});

test('ошибка закрепления откатывает кнопку и показывает сообщение', async ({ page, request }) => {
  await seedAcquisition(request, { pinFail: true });
  await page.goto('/album/924');
  await waitSynced(page);
  await page.getByTestId('server-download').click();
  await expect(page.getByText('Something went wrong').or(page.getByText('pin failed')).first()).toBeVisible();
  await expect(page.getByTestId('server-download')).toHaveText('Скачать на сервер');
});

test('пауза всех: строки показывают «на паузе», затем «Возобновить»', async ({ page, request }) => {
  await page.goto('/album/924');
  await waitSynced(page);
  await page.getByTestId('server-download').click();
  await setProgress(request, 924, 10 * MB);
  await page.goto('/downloads/downloading');
  await expect(row(page, 924)).toContainText('10%');
  await page.getByTestId('pause-all').click();
  await expect(page.getByTestId('pause-all')).toHaveText('Возобновить загрузки');
  await expect(row(page, 924)).toContainText('на паузе');
  await page.getByTestId('pause-all').click();
  await expect(page.getByTestId('pause-all')).toHaveText('Пауза всех загрузок');
  await expect(row(page, 924)).not.toContainText('на паузе');
});

test('вкладка «Торренты»: пауза одного торрента и возобновление', async ({ page }) => {
  await page.goto('/downloads/torrents');
  const first = page.getByTestId('torrent-aaa111');
  await expect(first).toContainText('Engine Torrent One');
  await first.getByTestId('torrent-pause').click();
  await expect(first.getByTestId('torrent-resume')).toBeVisible();
  await expect(first).toContainText('На паузе');
  await first.getByTestId('torrent-resume').click();
  await expect(first.getByTestId('torrent-pause')).toBeVisible();
});

test('упавшая задача: «Повторить» — строка исчезает', async ({ page }) => {
  await page.goto('/downloads/jobs');
  const job = page.getByTestId('job-71');
  await expect(job).toContainText('provider exploded');
  await expect(job.getByRole('link')).toHaveAttribute('href', '/album/921');
  await job.getByTestId('job-retry').click();
  await expect(page.getByTestId('job-71')).toHaveCount(0);
  await expect(page.getByText('Нет упавших задач')).toBeVisible();
});

test('старый адрес /settings/downloads ведёт на торренты', async ({ page }) => {
  await page.goto('/settings/downloads');
  await expect(page).toHaveURL(/\/downloads\/torrents$/);
});

test('мобильный размер: вкладки прокручиваются по горизонтали, действия строки — через меню', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 390 });
  await page.goto('/downloads');
  await waitSynced(page);
  const scroller = page.getByTestId('acq-tabs-scroll');
  await expect(scroller).toBeVisible();
  expect(await scroller.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await row(page, 921).getByTestId('row-menu').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByTestId('menu-sources')).toBeVisible();
  await expect(menu.getByTestId('menu-magnet')).toBeVisible();
});
