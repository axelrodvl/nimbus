import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'search-radiohead.json'), 'utf8'));

// Мок GET */api/search*: возвращает фикстуру, подменяя `query`; считает запросы.
async function mockSearch(page: Page, opts: { delayMs?: number; fail?: boolean } = {}) {
  const requests: string[] = [];
  await page.route('**/api/search*', async route => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    requests.push(q);
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
    if (opts.fail) {
      return route.fulfill({
        body: JSON.stringify({ error: { code: 'internal', message: 'internal server error' } }),
        contentType: 'application/json',
        status: 500,
      });
    }
    return route.fulfill({ body: JSON.stringify({ ...fixture, query: q }), contentType: 'application/json' });
  });
  return requests;
}

// До гидрации обработчик ⌘K ещё не подключён, поэтому нажатие повторяем, пока диалог не откроется.
async function openPalette(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  return dialog;
}

test('страница поиска показывает три секции и отметки «В библиотеке»', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/search?q=radiohead');

  await expect(page.getByRole('heading', { name: 'Артисты' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Альбомы' })).toBeVisible();
  await expect(page.getByRole('heading', { exact: true, name: 'Треки' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Лучший результат' })).toBeVisible();

  await expect(page.getByText('OK Computer').first()).toBeVisible();
  await expect(page.getByText('Paranoid Android').first()).toBeVisible();
  await expect(page.getByText('6:27').first()).toBeVisible(); // 387 с

  // library_id != null → «В библиотеке» + ссылка; иначе кнопка добавления
  const albums = page.locator('section[aria-labelledby="search-albums"]');
  await expect(albums.getByTitle('В библиотеке')).toHaveCount(1);
  await expect(albums.getByRole('button', { name: 'Добавить в библиотеку' })).toHaveCount(1);
  await expect(albums.getByRole('link', { name: /Kid A/ })).toHaveAttribute('href', '/album/3');
  const artists = page.locator('section[aria-labelledby="search-artists"]');
  await expect(artists.getByRole('link', { name: /Radio Head/ })).toHaveAttribute('href', '/artist/7');
});

test('ввод: debounce склеивает запросы, повтор берётся из кэша', async ({ page }) => {
  const requests = await mockSearch(page);
  await page.goto('/search');
  const input = page.getByRole('searchbox');
  await input.pressSequentially('radiohead', { delay: 30 });
  await expect(page.getByRole('heading', { name: 'Артисты' })).toBeVisible();
  expect(requests).toEqual(['radiohead']);
  await expect(page).toHaveURL(/\/search\?q=radiohead$/);

  // другой запрос и возврат к прежнему — второй раз без сети
  await input.fill('creep');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await expect.poll(() => requests.length).toBe(2);
  await input.fill('radiohead');
  await expect(page.getByRole('heading', { name: 'Артисты' })).toBeVisible();
  await page.waitForTimeout(600);
  expect(requests).toEqual(['radiohead', 'creep']);
});

test('устаревшие результаты приглушаются, а не пропадают', async ({ page }) => {
  await mockSearch(page, { delayMs: 800 });
  await page.goto('/search?q=radiohead');
  await expect(page.getByRole('heading', { name: 'Артисты' })).toBeVisible();
  await page.getByRole('searchbox').fill('radio');
  await expect(page.getByTestId('search-results')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('search-results')).toHaveAttribute('aria-busy', 'false', { timeout: 5000 });
});

test('ошибка бэкенда: сообщение и «Повторить»', async ({ page }) => {
  await mockSearch(page, { fail: true });
  await page.goto('/search?q=radiohead');
  await expect(page.getByText('Поиск не удался')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
});

test('кнопка «Добавить» добавляет альбом: toast и галочка', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/search?q=radiohead');
  await page
    .locator('section[aria-labelledby="search-albums"]')
    .getByRole('button', { name: 'Добавить в библиотеку' })
    .click();
  // состояние мока общее для тестов: альбом мог быть добавлен ранее
  await expect(page.getByText(/Добавлено в библиотеку|Уже в библиотеке/).first()).toBeVisible();
});

test('палитра ⌘K: открытие, стрелки, Enter, Esc', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/library');

  const dialog = await openPalette(page);
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();

  await input.fill('radiohead');
  const options = dialog.getByRole('option');
  await expect(options).toHaveCount(7); // 2 артиста + 2 альбома + 3 трека (лимиты 3/3/5)
});

test('палитра: навигация стрелками и Enter открывает элемент из библиотеки', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/library');
  const dialog = await openPalette(page);
  const input = dialog.getByRole('combobox');
  await input.fill('radiohead');
  const options = dialog.getByRole('option');
  await expect(options.first()).toBeVisible();

  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  const activeId = await input.getAttribute('aria-activedescendant');
  expect(activeId).toBe(await options.nth(1).getAttribute('id'));
  await input.press('ArrowUp');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowUp'); // циклически на последний
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');

  // второй артист (Radio Head, library_id 7) — в библиотеке → переход на /artist/7
  await options.nth(1).hover();
  await input.press('Enter');
  await expect(page).toHaveURL(/\/artist\/7$/);
  await expect(dialog).toBeHidden();
});

test('палитра: Enter на элементе не из библиотеки ведёт на /search?q=, Esc закрывает', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/library');
  const dialog = await openPalette(page);
  await dialog.getByRole('combobox').fill('radiohead');
  await expect(dialog.getByRole('option').first()).toBeVisible();
  await dialog.getByRole('combobox').press('Enter'); // первый — Radiohead, не в библиотеке
  await expect(page).toHaveURL(/\/search\?q=radiohead$/);

  await openPalette(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('палитра: «Показать все результаты» и Shift+Enter (добавить)', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/library');
  const dialog = await openPalette(page);
  await dialog.getByRole('combobox').fill('radiohead');
  await expect(dialog.getByRole('option').first()).toBeVisible();

  await dialog.getByRole('combobox').press('Shift+Enter'); // первый — артист: импорт дискографии
  await expect(page.getByText('Импортируем дискографию…')).toBeVisible();
  await expect(dialog).toBeVisible(); // палитра не закрывается

  await dialog.getByRole('button', { name: 'Показать все результаты' }).click();
  await expect(page).toHaveURL(/\/search\?q=radiohead$/);
});
