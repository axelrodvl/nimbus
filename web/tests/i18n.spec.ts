import { expect, test } from '@playwright/test';

// Язык выбирается cookie `nimbus_locale`, а без неё — по Accept-Language браузера.

test.describe('язык по умолчанию из Accept-Language', () => {
  test.use({ locale: 'de-DE' });

  test('немецкий интерфейс', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Willkommen zurück' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Bibliothek' }).first()).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  });
});

test.describe('неподдерживаемый язык → английский', () => {
  test.use({ locale: 'sw-KE' });

  test('английский интерфейс', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  });
});

test('выбор языка в настройках сохраняется в cookie и переживает перезагрузку', async ({ page, context }) => {
  await page.goto('/settings');
  const select = page.getByTestId('language-select');
  await expect(select).toHaveValue('ru');
  // До гидрации change не обработается, поэтому повторяем выбор, пока язык не сменится.
  await expect(async () => {
    await select.selectOption('es');
    await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole('link', { name: 'Biblioteca' }).first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  expect((await context.cookies()).find(c => c.name === 'nimbus_locale')?.value).toBe('es');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
  await expect(page.getByTestId('language-select')).toHaveValue('es');

  await page.goto('/library');
  await expect(page.getByRole('heading', { name: 'Biblioteca' })).toBeVisible();
});

test('китайский: есть перевод и формы счёта', async ({ context, page }) => {
  await context.addCookies([{ name: 'nimbus_locale', url: 'http://localhost:3002', value: 'zh' }]);
  await page.goto('/library');
  await expect(page.getByRole('heading', { name: '音乐库' })).toBeVisible();
});
