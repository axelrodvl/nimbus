import { expect, test } from '@playwright/test';

test('главная открывается, навигация видна', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'С возвращением' })).toBeVisible();
  const nav = page.getByRole('link', { name: 'Библиотека' }).first();
  await expect(nav).toBeVisible();
});

test('навигация по разделам', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Поиск' }).first().click();
  await expect(page).toHaveURL(/\/search$/);
  await page.getByRole('link', { name: 'Библиотека' }).first().click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole('heading', { name: 'Библиотека' })).toBeVisible();
});

test('индикатор соединения присутствует и не роняет страницу без бэкенда', async ({ page }) => {
  await page.goto('/');
  const indicator = page.getByRole('status', { name: /бэкенд/i }).first();
  await expect(indicator).toBeVisible();
});
