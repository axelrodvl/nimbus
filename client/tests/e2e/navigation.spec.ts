import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetMock, seedMock } from './mock';

// «Назад» и «вперёд» открывают прежний экран строго как был: в первом же кадре с ним — его позиция прокрутки
// (без кадра «экран сверху → прыжок»), и между уходящим и прежним экраном нет пустого кадра.

const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');

type Frame = { arriving: boolean; leaving: boolean; top: number };

/**
 * Покадровая запись (rAF — перед каждой отрисовкой): виден ли уходящий и приходящий экран и прокрутка оболочки.
 * Запись идёт `ms` миллисекунд; результат забирает возвращённая функция.
 */
async function recordFrames(page: Page, leaving: string, arriving: string, ms = 1500) {
  await page.evaluate(
    ([from, to, duration]) => {
      const w = window as unknown as { __frames: Frame[]; __recording: Promise<void> };
      w.__frames = [];
      w.__recording = new Promise(resolve => {
        const t0 = performance.now();
        const tick = () => {
          w.__frames.push({
            arriving: document.querySelector(to as string) !== null,
            leaving: document.querySelector(from as string) !== null,
            top: document.querySelector('[data-scroll-root]')!.scrollTop,
          });
          if (performance.now() - t0 < (duration as number)) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
    },
    [leaving, arriving, ms] as const,
  );
  return async () =>
    page.evaluate(async () => {
      const w = window as unknown as { __frames: Frame[]; __recording: Promise<void> };
      await w.__recording;
      return w.__frames;
    });
}

/** Каждый кадр с прежним экраном — на запомненной позиции; в каждом кадре виден один из двух экранов. */
function expectSeamless(frames: Frame[], top: number) {
  const shown = frames.filter(f => f.arriving);
  expect(shown.length).toBeGreaterThan(0);
  expect(frames.filter(f => !f.arriving && !f.leaving)).toEqual([]);
  expect(shown.map(f => Math.round(f.top))).toEqual(shown.map(() => Math.round(top)));
}

async function scrollMain(page: Page, top: number): Promise<number> {
  const main = page.locator('[data-scroll-root]');
  await main.evaluate((el, y) => el.scrollTo(0, y), top);
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBeGreaterThan(Math.min(top, 100) / 2);
  // Событие scroll должно дойти до восстановления прокрутки.
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  return main.evaluate(el => el.scrollTop);
}

/** Нажимает ссылку из видимой части списка, не прокручивая страницу (клик Playwright мог бы её прокрутить). */
async function clickVisibleLink(list: Locator): Promise<void> {
  const click = () =>
    list.evaluate(root => {
      const box = document.querySelector('[data-scroll-root]')!.getBoundingClientRect();
      const link = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).find(a => {
        const b = a.getBoundingClientRect();
        const y = (b.top + b.bottom) / 2;
        return b.width > 0 && y > box.top + 4 && y < box.bottom - 4;
      });
      link?.click();
      return link !== undefined;
    });
  await expect.poll(click).toBe(true);
}

test.describe('«назад» без морганий', () => {
  test.describe('большая библиотека', () => {
    test.beforeEach(async ({ request }) => {
      await resetMock(request);
      await seedMock(request, { albums: 600, artists: 120, tracks: 6000 });
    });

    test('список треков → артист → назад: с первого кадра на прежней позиции', async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto('/library/tracks');
      await waitSynced(page);
      await expect(page.getByTestId('library-tracks')).toBeVisible();
      const top = await scrollMain(page, 6000);
      await clickVisibleLink(page.getByTestId('library-tracks'));
      await expect(page).toHaveURL(/\/(artist|album)\/\d+$/);
      await expect(page.getByTestId('library-tracks')).toHaveCount(0);

      const frames = await recordFrames(page, 'main h1', '[data-testid=library-tracks]');
      await page.goBack();
      await expect(page.getByTestId('library-tracks')).toBeVisible();
      expectSeamless(await frames(), top);
    });

    test('альбом прокручен → назад → вперёд: альбом на своей позиции с первого кадра', async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ height: 420, width: 1280 });
      await page.goto('/library/albums');
      await waitSynced(page);
      const top = await scrollMain(page, 2000);
      await clickVisibleLink(page.getByTestId('library-albums'));
      await expect(page.getByTestId('album-tracks')).toBeVisible();
      const albumTop = await scrollMain(page, 250);
      expect(albumTop).toBeGreaterThan(50);

      let frames = await recordFrames(page, '[data-testid=album-tracks]', '[data-testid=library-albums]');
      await page.goBack();
      await expect(page.getByTestId('library-albums')).toBeVisible();
      expectSeamless(await frames(), top);

      frames = await recordFrames(page, '[data-testid=library-albums]', '[data-testid=album-tracks]');
      await page.goForward();
      await expect(page.getByTestId('album-tracks')).toBeVisible();
      expectSeamless(await frames(), albumTop);
    });

    test('позиция переживает перезагрузку страницы', async ({ page }) => {
      test.setTimeout(120_000);
      // Список открыт переходом внутри приложения: у первой записи вкладки (открытой загрузкой) ключ общий —
      // её позиция живёт только в памяти.
      await page.goto('/');
      await waitSynced(page);
      await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
      await page.getByTestId('tab-albums').click();
      await expect(page.getByTestId('library-albums')).toBeVisible();
      const top = await scrollMain(page, 2000);
      await clickVisibleLink(page.getByTestId('library-albums'));
      await expect(page.getByTestId('album-tracks')).toBeVisible();
      await page.reload();
      await expect(page.getByTestId('album-tracks')).toBeVisible();
      await page.goBack();
      await expect(page.getByTestId('library-albums')).toBeVisible();
      const main = page.locator('[data-scroll-root]');
      await expect.poll(() => main.evaluate(el => Math.round(el.scrollTop))).toBe(Math.round(top));
    });
  });

  test('результаты поиска → альбом каталога → назад: поиск на прежней позиции с первого кадра', async ({
    page,
    request,
  }) => {
    await resetMock(request);
    await page.setViewportSize({ height: 420, width: 1280 });
    await page.goto('/');
    await waitSynced(page);
    await page.getByTestId('sidebar').getByRole('link', { name: 'Поиск' }).click();
    await page.getByRole('searchbox').fill('radiohead');
    await expect(page.getByTestId('search-tracks')).toBeVisible();
    const top = await scrollMain(page, 300);
    await clickVisibleLink(page.getByTestId('search-results'));
    await expect(page).not.toHaveURL(/\/search\?q=/);
    await expect(page.getByTestId('search-results')).toHaveCount(0);

    const frames = await recordFrames(page, 'main h1', '[data-testid=search-results]');
    await page.goBack();
    await expect(page.getByTestId('search-results')).toBeVisible();
    expectSeamless(await frames(), top);
  });
});
