import { expect, test } from '@playwright/test';
import { resetMock } from './mock';

test.beforeEach(async ({ request }) => resetMock(request));

test('страница открывается, тема переключается и переживает перезагрузку', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Nimbus' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

  const html = page.locator('html');
  await expect(html).toHaveClass(/dark/);

  await page.getByRole('button', { name: 'Светлая тема' }).click();
  await expect(html).not.toHaveClass(/dark/);

  await page.reload();
  await expect(html).not.toHaveClass(/dark/);
  await expect(page.getByRole('button', { name: 'Светлая тема' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Тёмная тема' }).click();
  await expect(html).toHaveClass(/dark/);
});

test('прокси /api доходит до мока бэкенда', async ({ request }) => {
  const res = await request.get('/api/auth/session');
  expect(await res.json()).toEqual({ auth_required: false, authenticated: true });
});
