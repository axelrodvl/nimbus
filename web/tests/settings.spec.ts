import { expect, test, type Page } from '@playwright/test';

const MOCK = `http://localhost:${process.env.MOCK_BACKEND_PORT ?? 4010}`;

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK}/__reset`);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
type Entry = { method: string; path: string; body?: Body };
const log = async (page: Page) => (await page.request.get(`${MOCK}/__log`)).json() as Promise<Entry[]>;
const puts = async (page: Page) => (await log(page)).filter(r => r.method === 'PUT' && r.path === '/api/settings');
const section = (page: Page, id: string) => page.getByTestId(`settings-${id}`);

test('секреты не показываются: поле пустое, плейсхолдер-маска, в PUT уходит пустая строка', async ({ page }) => {
  await page.goto('/settings');
  const providers = section(page, 'providers');
  await expect(providers.getByLabel('Логин')).toHaveValue('bob');
  const password = providers.getByLabel('Пароль');
  await expect(password).toHaveValue('');
  await expect(password).toHaveAttribute('placeholder', '••••');
  await expect(page.locator('body')).not.toContainText('secret-pw');

  await providers.getByLabel('Прокси').fill('socks5://127.0.0.1:1080');
  await providers.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('«Источники»: сохранено')).toBeVisible();
  const [put] = await puts(page);
  expect(put?.body?.providers.rutracker).toMatchObject({
    password: '',
    proxy: 'socks5://127.0.0.1:1080',
    username: 'bob',
  });
  // Торрент-провайдеры: Torznab без URL → сброс
  expect(put?.body?.providers.torznab).toBeNull();
  expect(JSON.stringify(put?.body)).not.toContain('secret-pw');
});

test('хранилище: индикатор использования и сохранение лимита, раздачи и рейтинга', async ({ page }) => {
  await page.goto('/settings');
  const storage = section(page, 'storage');
  await expect(storage.getByTestId('storage-usage')).toContainText('Занято 3.0 ГБ из 50 ГБ');
  await expect(storage).toContainText('повышает рейтинг');

  await storage.getByLabel('Лимит кэша, ГБ').fill('20');
  await storage.getByLabel('Раздавать скачанное (seeding)').check();
  await storage.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('«Хранилище»: сохранено')).toBeVisible();
  const [put] = await puts(page);
  expect(put?.body).toEqual({ storage: { cache_limit_gb: 20, seed_ratio: null, seeding: true } });

  await page.reload();
  await expect(section(page, 'storage').getByLabel('Лимит кэша, ГБ')).toHaveValue('20');
  await expect(section(page, 'storage').getByLabel('Раздавать скачанное (seeding)')).toBeChecked();
});

test('ошибка валидации бэкенда показывается тостом', async ({ page }) => {
  await page.goto('/settings');
  const storage = section(page, 'storage');
  await storage.getByLabel('Лимит кэша, ГБ').evaluate((el: HTMLInputElement) => (el.min = '0'));
  await storage.getByLabel('Лимит кэша, ГБ').fill('0');
  await storage.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('cache_limit_gb must be at least 1')).toBeVisible();
});

test('поиск и сопоставление: порядок форматов, пороги, пропускаемые типы', async ({ page }) => {
  await page.goto('/settings');
  const search = section(page, 'search');
  await search.getByRole('button', { name: 'Выше: ALAC' }).click();
  await search.getByLabel('Пропускать типы релизов').fill('Live, Demo');
  await search.getByLabel('Порог уверенного совпадения').fill('0.9');
  await search.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('«Поиск и сопоставление»: сохранено')).toBeVisible();
  const [put] = await puts(page);
  expect(put?.body?.search.format_prefs.slice(0, 2)).toEqual(['alac', 'flac']);
  expect(put?.body?.search.skip_secondary_types).toEqual(['Live', 'Demo']);
  expect(put?.body?.matching).toEqual({ accept: 0.9, confirm: 0.65 });
});

test('кнопка «Проверить» показывает результат пробного поиска', async ({ page }) => {
  await page.goto('/settings');
  await section(page, 'providers').getByRole('button', { name: 'Проверить The Pirate Bay' }).click();
  await expect(page.getByTestId('test-tpb')).toHaveText('Найдено раздач: 25');
  const posts = (await log(page)).filter(r => r.path === '/api/settings/providers/test');
  expect(posts[0]?.body).toEqual({ provider: 'tpb' });
});

test('плеер предзагружает следующий найденный трек', async ({ page }) => {
  await page.goto('/album/103');
  await page.getByTestId('play-album').first().click();
  await expect.poll(async () => (await log(page)).some(r => r.path === '/api/tracks/1034/prefetch')).toBe(true);
});
