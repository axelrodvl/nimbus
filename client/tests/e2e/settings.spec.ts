import { expect, test, type Page } from '@playwright/test';
import { mockSettings, resetMock, setSettingsFaults } from './mock';

const SECTIONS = ['sources', 'search', 'musicbrainz', 'playback', 'storage', 'performance', 'appearance', 'about'];

test.beforeEach(async ({ request }) => resetMock(request));

test('лимит кэша и порядок форматов сохраняются и переживают перезагрузку', async ({ page, request }) => {
  await page.goto('/settings/storage');
  const limit = page.getByRole('spinbutton', { name: 'Лимит кэша, ГБ' });
  await expect(limit).toHaveValue('50');
  await limit.fill('80');
  await limit.press('Enter');
  await expect(page.getByTestId('save-status')).toHaveText('Сохранено');

  await page.goto('/settings/search');
  await page.getByRole('button', { name: 'Вниз: FLAC' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Сохранено');

  await page.reload();
  await expect(page.getByTestId('format-order').getByRole('listitem').first()).toContainText('ALAC');
  await page.goto('/settings/storage');
  await expect(page.getByRole('spinbutton', { name: 'Лимит кэша, ГБ' })).toHaveValue('80');
  const saved = (await mockSettings(request)) as { storage: { cache_limit_gb: number } };
  expect(saved.storage.cache_limit_gb).toBe(80);
});

test('ошибка валидации показывается у поля и не сохраняется', async ({ page }) => {
  await page.goto('/settings/musicbrainz');
  const burst = page.getByRole('spinbutton', { name: 'Burst' });
  await burst.fill('3');
  await burst.press('Enter');
  // Значение вне границ ограничивается клиентом, поэтому ошибку сервера вызываем адресом без слэша.
  const url = page.getByRole('textbox', { name: 'Адрес сервера' });
  await url.fill('http://mirror.local/ws/2');
  await url.press('Enter');
  await expect(page.getByText('musicbrainz.base_url must be an http(s) URL ending with "/"')).toBeVisible();
  await expect(url).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('save-status')).toHaveText('Ошибка');
});

test('«Проверить» провайдера: успех и ошибка', async ({ page, request }) => {
  await page.goto('/settings/sources');
  const test = page.getByRole('button', { name: 'Проверить tpb' });
  await test.click();
  await expect(page.getByTestId('test-result-tpb')).toHaveText('OK: 12 results');
  await setSettingsFaults(request, { providerTestOk: false });
  await test.click();
  await expect(page.getByTestId('test-result-tpb')).toHaveText('Login rejected');
});

test('секрет: пустое поле ничего не меняет, значение уходит по кнопке и отдаётся маской', async ({ page, request }) => {
  await page.goto('/settings/sources');
  await page.getByRole('textbox', { name: 'URL' }).fill('http://tz.local');
  await page.getByRole('textbox', { name: 'URL' }).press('Enter');
  await expect(page.getByTestId('save-status')).toHaveText('Сохранено');
  const key = page.getByLabel('API-ключ');
  await key.fill('s3cret');
  await page.getByRole('button', { name: 'Сохранить' }).first().click();
  await expect(key).toHaveAttribute('placeholder', '••••');
  await expect(key).toHaveValue('');
  const saved = (await mockSettings(request)) as { providers: { torznab: { api_key: string } } };
  expect(saved.providers.torznab.api_key).toBe('s3cret');
  await page.reload();
  await expect(page.getByLabel('API-ключ')).toHaveAttribute('placeholder', '••••');
});

test('мобильный размер: список разделов → раздел → назад', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 390 });
  await page.goto('/settings');
  await expect(page.getByTestId('settings-nav')).toBeVisible();
  await expect(page.getByTestId('settings-sources')).toBeHidden();
  await page.getByTestId('settings-link-search').click();
  await expect(page).toHaveURL(/\/settings\/search$/);
  await expect(page.getByTestId('settings-search')).toBeVisible();
  await expect(page.getByTestId('settings-nav')).toBeHidden();
  await page.getByTestId('settings-back').click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('settings-nav')).toBeVisible();
});

test('внешний вид: язык и тема переключаются и запоминаются', async ({ page }) => {
  await page.goto('/settings/appearance');
  await page.getByRole('radio', { name: 'Светлая' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByTestId('language-select').click();
  await page.getByRole('option', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
});

test('галерея примитивов открывается', async ({ page }) => {
  await page.goto('/dev/ui');
  await expect(page.getByTestId('ui-gallery')).toBeVisible();
});

async function shoot(page: Page, name: string, outputPath: (n: string) => string) {
  await page.waitForTimeout(150);
  await page.screenshot({ fullPage: true, path: outputPath(name) });
}

for (const locale of ['ru', 'de']) {
  test(`скриншоты галереи и разделов (${locale}): темы × 390/1440 px`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.addInitScript(l => localStorage.setItem('nimbus:locale', l), locale);
    for (const theme of ['light', 'dark']) {
      await page.addInitScript(t => localStorage.setItem('nimbus:theme', t), theme);
      for (const width of [390, 1440]) {
        await page.setViewportSize({ height: width === 390 ? 844 : 900, width });
        for (const path of ['/dev/ui', ...SECTIONS.map(s => `/settings/${s}`)]) {
          await page.goto(path);
          await page.evaluate(t => {
            localStorage.setItem('nimbus:theme', t);
            document.documentElement.classList.toggle('dark', t === 'dark');
          }, theme);
          await expect(page.getByRole('main')).toBeVisible();
          await shoot(page, `${locale}-${theme}-${width}-${path.replaceAll('/', '_')}.png`, n =>
            testInfo.outputPath(n),
          );
        }
      }
    }
  });
}
