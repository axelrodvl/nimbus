import { expect, test, type Page } from '@playwright/test';

// Мок-бэкенд: артист 20 — «ждём MusicBrainz» (попытка 2 из 8), артист 21 — импорт не удался.
const MOCK = process.env.MOCK_BACKEND_URL ?? 'http://localhost:4010';

// Артист 21 меняется кнопкой «Повторить»: перед тестом возвращаем его в «не удалось» (полный сброс мока
// нельзя: остальные тесты идут параллельно и делят его состояние).
async function failedArtist(page: Page) {
  await page.request.get(`${MOCK}/__artist-import-failed`);
}

test('артист: идёт повтор — видно попытку и время следующей', async ({ page }) => {
  await page.goto('/artist/20');
  const status = page.getByTestId('artist-import');
  await expect(status).toHaveAttribute('data-state', 'retrying');
  await expect(status).toContainText('MusicBrainz не отвечает');
  await expect(status).toContainText('попытка 2 из 8');
  await expect(status).toContainText('примерно через 3 мин');
});

test('артист: импорт не удался — сообщение и кнопка «Повторить» запускает импорт заново', async ({ page }) => {
  await failedArtist(page);
  await page.goto('/artist/21');
  const status = page.getByTestId('artist-import');
  await expect(status).toHaveAttribute('data-state', 'failed');
  await expect(status).toContainText('Сдались после 8 попыток');

  await status.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByText('Импорт запущен заново')).toBeVisible();
  await expect(page.getByTestId('artist-import')).toHaveAttribute('data-state', 'importing');
  const log = await (await page.request.get(`${MOCK}/__log`)).json();
  expect(log.some((r: { method: string; path: string }) => r.method === 'POST' && r.path === '/api/artists/21/import')).toBe(
    true,
  );
});

test('библиотека: у карточек артистов есть бейдж статуса импорта', async ({ page }) => {
  await failedArtist(page);
  await page.goto('/library?tab=artists');
  const cards = page.getByTestId('library-artists');
  await expect(cards.getByRole('link', { name: /Retry Artist/ }).getByTestId('artist-import-badge')).toHaveText(
    'Ждём MusicBrainz…',
  );
  await expect(cards.getByRole('link', { name: /Failed Artist/ }).getByTestId('artist-import-badge')).toHaveText(
    'Импорт не удался',
  );
  await expect(cards.getByRole('link', { name: /Radiohead/ }).getByTestId('artist-import-badge')).toHaveCount(0);
});

test('артист: идёт импорт — одна строка прогресса и подробный журнал по нажатию', async ({ page }) => {
  await page.goto('/artist/22');
  const status = page.getByTestId('artist-import').first();
  await expect(status).toContainText('Импорт альбомов: 3 из 12 — Recovery');
  await expect(page.getByTestId('artist-import-log').first()).toHaveCount(0);
  await status.getByRole('button').click();
  const log = page.getByTestId('artist-import-log').first();
  await expect(log).toContainText('Found 12 release groups');
  await expect(log).toContainText('Added "Relapse"');
});
