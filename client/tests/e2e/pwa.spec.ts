import { expect, test, type Page } from '@playwright/test';
import { mockLog, resetMock, seedPlayer } from './mock';
import { makeVariant, serveVariants } from './variants';

const MOCK = `http://localhost:${process.env.MOCK_BACKEND_PORT ?? 4011}`;
const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');

/** Service worker активен и управляет страницей. */
async function swReady(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // Словарь текущего языка догружается в кэш после активации воркера (иначе офлайн-старт был бы на английском).
  await expect
    .poll(() =>
      page.evaluate(() =>
        caches
          .open('nimbus-runtime-v1')
          .then(c => c.keys())
          .then(k => k.length),
      ),
    )
    .toBeGreaterThan(0);
}

test.beforeEach(async ({ request }) => resetMock(request));

test('манифест: standalone, иконки (в том числе maskable), ярлыки; метатеги Apple и тема', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = (await (await request.get(new URL(href!, page.url()).toString())).json()) as Record<string, unknown>;
  expect(manifest).toMatchObject({ display: 'standalone', id: '/', name: 'Nimbus', scope: '/', start_url: '/' });
  const icons = manifest.icons as { purpose: string; sizes: string }[];
  expect(icons.some(i => i.purpose === 'maskable')).toBe(true);
  expect(icons.some(i => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
  expect((manifest.shortcuts as { url: string }[]).map(s => s.url)).toEqual(['/search', '/library']);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
});

test('офлайн: холодный старт на /album/:id из оболочки и IndexedDB; локальный поиск; изменения и настройки сервера недоступны', async ({
  context,
  page,
}) => {
  await page.goto('/album/1');
  await waitSynced(page);
  await swReady(page);
  const title = await page.getByRole('heading', { level: 1 }).first().innerText();

  await context.setOffline(true);
  const started = Date.now();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 }).first()).toHaveText(title);
  const coldStartMs = Date.now() - started;
  // Холодный старт без сети: оболочка из precache + библиотека из IndexedDB (в бюджет с запасом на медленный CI).
  expect(coldStartMs).toBeLessThan(5000);
  test.info().annotations.push({ description: `${coldStartMs} ms`, type: 'cold-start-offline' });
  await expect(page.getByTestId('sync-status')).toContainText('Нет связи');

  // Поиск: только локальные результаты и пояснение.
  await page.getByTestId('sidebar').getByRole('link', { name: 'Поиск' }).click();
  await page.getByRole('searchbox').fill('artist');
  await expect(page.getByTestId('search-offline')).toBeVisible();
  await expect(page.getByTestId('search-local')).toContainText('Artist 1');

  // Добавление в плейлист: понятное сообщение вместо тихого сбоя.
  await page.goto('/album/1');
  await page.locator('[data-track-id]').first().getByTestId('track-menu').click();
  await page.getByRole('menuitem', { name: 'Добавить в плейлист' }).click();
  await page.getByTestId('playlist-picker').getByRole('button').first().click();
  await expect(page.getByText('Нет сети — сейчас это изменить нельзя').first()).toBeVisible();

  // Настройки сервера офлайн: пояснение вместо skeleton.
  await page.goto('/settings/search');
  await expect(page.getByTestId('offline-notice')).toBeVisible();
  // Настроек сервера в памяти нет: вместо бесконечного skeleton — пояснение (с данными поля были бы только для чтения).
  await expect(page.getByRole('alert')).toContainText('Настройки сервера недоступны без сети');
});

test('онлайн снова: индикатор исчез, выполнена дельта, отложенное прослушивание отправлено', async ({
  context,
  page,
  request,
}) => {
  await seedPlayer(request);
  await page.goto('/album/903');
  await waitSynced(page);
  await swReady(page);

  await expect(page.getByRole('heading', { name: 'Player Test' })).toBeVisible();
  await page.getByTestId('play-album').first().click();
  // Сеть пропадает до засчитывания прослушивания (≈ 3 с): запись уходит в outbox.
  await context.setOffline(true);
  await expect(page.getByText('Нет сети — переподключаемся…')).toBeVisible();
  await page.waitForTimeout(4000);
  expect((await mockLog(request)).filter(l => l === 'POST /api/tracks/9031/played')).toHaveLength(0);

  await context.setOffline(false);
  await expect(page.getByText('Нет сети — переподключаемся…')).toHaveCount(0, { timeout: 45_000 });
  await expect
    .poll(async () => (await mockLog(request)).filter(l => l === 'POST /api/tracks/9031/played').length, {
      timeout: 30_000,
    })
    .toBe(1);
  expect((await mockLog(request)).filter(l => l.endsWith('/api/sync/changes')).length).toBeGreaterThan(0);
});

test('изображения (фото артистов) после первой загрузки показываются офлайн из кэша service worker', async ({
  context,
  page,
  request,
}) => {
  await page.goto('/library/artists');
  await waitSynced(page);
  await swReady(page);
  await page.reload();
  const loaded = () =>
    page.evaluate(() => [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth > 0).length);
  await expect.poll(loaded).toBeGreaterThan(0);
  const shown = await loaded();
  const requests = (await mockLog(request)).filter(l => l.includes('/api/artist-image/')).length;
  expect(requests).toBeGreaterThan(0);

  await context.setOffline(true);
  await page.reload();
  await expect.poll(loaded).toBeGreaterThanOrEqual(shown);
  await context.setOffline(false);
  // Запросов к мок-серверу за картинками не прибавилось: оболочка и картинки отданы из кэша.
  expect((await mockLog(request)).filter(l => l.includes('/api/artist-image/')).length).toBe(requests);
  expect(MOCK).toContain('localhost');
});

test('обновление версии: v1 → v2 → v3, предложение, «Обновить» — перезагрузка, одноразовое «Обновлено до версии X»', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await swReady(page);
  const v1 = await page.evaluate(() => localStorage.getItem('nimbus:pwa:version'));
  expect(v1).toBeTruthy();
  const server = await serveVariants(MOCK, `${process.cwd()}/dist`);
  try {
    await page.goto(server.url);
    await swReady(page);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('nimbus:pwa:version'))).toBe(v1);

    let current = v1!;
    for (const next of ['2.0.0-e2e', '3.0.0-e2e']) {
      // Каждый вариант строится из `dist/` (версия v1 → `next`): для service worker это новая сборка.
      server.dir = makeVariant(v1!, next);
      // Возврат из фона: уход (hidden) и возвращение (visible) — lifecycle сводит их к одному `foreground`.
      await page.evaluate(() => {
        for (const value of ['hidden', 'visible']) {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value });
          document.dispatchEvent(new Event('visibilitychange'));
        }
      });
      await expect(page.getByText('Доступна новая версия')).toBeVisible({ timeout: 20_000 });
      // Страница пока старая: никакой автоперезагрузки.
      expect(await page.evaluate(() => localStorage.getItem('nimbus:pwa:version'))).toBe(current);
      await page.getByRole('button', { name: 'Обновить' }).click();
      await expect(page.getByText(`Обновлено до версии ${next}`)).toBeVisible({ timeout: 20_000 });
      expect(await page.evaluate(() => localStorage.getItem('nimbus:pwa:version'))).toBe(next);
      current = next;
    }
  } finally {
    await server.close();
  }
});
