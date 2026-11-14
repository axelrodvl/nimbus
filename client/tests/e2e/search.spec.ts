import { expect, test, type Page } from '@playwright/test';
import { mockLog, resetMock, setSearch } from './mock';

const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
const searchRequests = async (request: Parameters<typeof mockLog>[0]) =>
  (await mockLog(request)).filter(l => l === 'GET /api/search').length;

/** Открывает поиск через боковую панель и вводит запрос. */
async function searchFor(page: Page, query: string) {
  await page.getByTestId('sidebar').getByRole('link', { name: 'Поиск' }).click();
  await page.getByRole('searchbox').fill(query);
}

test.describe('поиск', () => {
  test.beforeEach(async ({ request }) => resetMock(request));

  test('radiohead → секции → добавить альбом → «добавляется» → альбом в библиотеке без перезагрузки → ссылка «Открыть»', async ({
    page,
    request,
  }) => {
    await setSearch(request, { addDelayMs: 800 });
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    await expect(page).toHaveURL(/\/search\?q=radiohead$/);
    await expect(page.getByTestId('search-artists')).toBeVisible();
    await expect(page.getByTestId('search-albums')).toBeVisible();
    await expect(page.getByTestId('search-tracks')).toBeVisible();

    const card = page.getByTestId('remote-album').filter({ hasText: 'OK Computer' });
    await card.getByRole('button', { name: 'Добавить в библиотеку' }).click();
    await expect(card.getByRole('button', { name: 'Добавляется…' })).toBeDisabled();
    // Дельта принесла альбом: кнопка превратилась в ссылку.
    const open = card.getByRole('link', { name: 'Открыть' });
    await expect(open).toBeVisible();
    await expect(card.getByText('В библиотеке')).toBeVisible();

    await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
    await expect(page.getByTestId('tab-albums')).toContainText('9');
    await expect(page.getByTestId('library-albums').getByText('OK Computer')).toBeVisible();
  });

  test('добавление артиста: на главной появляется карточка импортируемого артиста', async ({ page, request }) => {
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    const artist = page.getByTestId('remote-artist').filter({ hasText: 'Radiohead' }).first();
    await artist.getByRole('button', { name: 'Добавить в библиотеку' }).click();
    await expect(artist.getByRole('link', { name: 'Открыть' })).toBeVisible();
    await page.getByTestId('sidebar').getByRole('link', { name: 'Главная' }).click();
    const card = page.getByTestId('home-recent').getByTestId('artist-card').filter({ hasText: 'Radiohead' });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('artist-import-badge')).toBeVisible();
    expect(await searchRequests(request)).toBe(1);
  });

  test('⌘K с экрана альбома → локальный трек → Enter → открыт его альбом', async ({ page }) => {
    await page.goto('/album/1');
    await expect(page.getByTestId('album-tracks')).toBeVisible();
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: 'Поиск артистов, альбомов и треков' });
    await expect(input).toBeFocused();
    await input.fill('Track 25');
    await expect(page.getByRole('option', { name: /Track 25/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/album\/3$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('«/» открывает палитру, Esc закрывает', async ({ page }) => {
    await page.goto('/');
    await waitSynced(page);
    await page.keyboard.press('/');
    await expect(page.getByRole('dialog', { name: 'Поиск' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('MusicBrainz недоступен: сообщение и «Повторить», локальные результаты видны; повтор работает', async ({
    page,
    request,
  }) => {
    await setSearch(request, { failStatus: 502 });
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'artist');
    await expect(page.getByText('Поиск не удался')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('search-local')).toContainText('Artist 1');
    await setSearch(request, {});
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.getByTestId('search-results')).toBeVisible();
  });

  test('офлайн: только локальные результаты и пояснение', async ({ context, page }) => {
    await page.goto('/');
    await waitSynced(page);
    await context.setOffline(true);
    await searchFor(page, 'artist');
    await expect(page.getByTestId('search-offline')).toBeVisible();
    await expect(page.getByTestId('search-local')).toContainText('Artist 1');
    await expect(page.getByTestId('search-results')).toHaveCount(0);
  });

  test('«назад» со страницы альбома возвращает те же результаты без новых запросов к /api/search', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    const card = page.getByTestId('remote-album').filter({ hasText: 'OK Computer' });
    await card.getByRole('button', { name: 'Добавить в библиотеку' }).click();
    await card.getByRole('link', { name: 'Открыть' }).click();
    await expect(page).toHaveURL(/\/album\/\d+$/);
    expect(await searchRequests(request)).toBe(1);
    await page.goBack();
    await expect(page.getByTestId('search-albums')).toBeVisible();
    await expect(page.getByRole('searchbox')).toHaveValue('radiohead');
    expect(await searchRequests(request)).toBe(1);
  });
});
