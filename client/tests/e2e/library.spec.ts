import { expect, test, type Page } from '@playwright/test';
import { failDelete, mockLog, mutate, resetMock, seedMock, setImport } from './mock';

const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');

/** Время от клика до появления элемента, мс (по `performance.now()` в странице). */
const timeToAppear = (page: Page, click: string, appears: string) =>
  page.evaluate(
    ([clickSelector, appearSelector]) =>
      new Promise<number>(resolve => {
        const t0 = performance.now();
        (document.querySelector(clickSelector as string) as HTMLElement).click();
        const check = () => {
          if (document.querySelector(appearSelector as string)) resolve(performance.now() - t0);
          else requestAnimationFrame(check);
        };
        check();
      }),
    [click, appears],
  );

// Картинки артистов (`/api/artist-image/…`) грузятся лениво браузером — это не запросы за данными библиотеки.
// Сводка «Загрузок» (`/api/acquisition/summary`, значок в навигации) — серверное состояние, не данные библиотеки.
// Состояние альбома на сервере (кнопка «Скачать на сервер») приходит синхронизацией: запроса быть не должно (ревью S11).
const dataRequests = (log: string[]) =>
  log.filter(
    l =>
      l.startsWith('GET /api/') &&
      !l.includes('/api/artists/') &&
      !l.includes('/api/artist-image/') &&
      !l.includes('/api/acquisition/summary'),
  );

test.describe('экраны библиотеки', () => {
  test.beforeEach(async ({ request }) => resetMock(request));

  test('главная → альбом → артист → назад → назад: ни одного запроса за данными библиотеки', async ({ page, request }) => {
    await page.goto('/');
    await waitSynced(page);
    await expect(page.getByTestId('home-recent')).toBeVisible();
    const before = (await mockLog(request)).length;

    await page.getByTestId('home-recent').getByRole('link').first().click();
    await expect(page).toHaveURL(/\/album\/\d+$/);
    await expect(page.getByTestId('album-tracks')).toBeVisible();
    await page.getByRole('main').getByRole('link', { name: /Artist \d/ }).first().click();
    await expect(page).toHaveURL(/\/artist\/\d+$/);
    await expect(page.getByTestId('artist-counts')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('album-tracks')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('home-recent')).toBeVisible();

    const added = (await mockLog(request)).slice(before);
    expect(dataRequests(added)).toEqual([]);
  });

  test('без сети переходы между экранами работают, данные на месте', async ({ context, page }) => {
    await page.goto('/');
    await waitSynced(page);
    await context.setOffline(true);
    await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
    await expect(page.getByTestId('library-albums')).toBeVisible();
    await page.getByTestId('library-albums').getByRole('link').first().click();
    await expect(page.getByTestId('album-tracks').getByTestId('track-row')).toHaveCount(10);
    await page.getByRole('main').getByRole('link', { name: /Artist \d/ }).first().click();
    await expect(page.getByTestId('artist-counts')).toContainText('альбом');
  });

  test('удаление альбома: исчезает из списка и после перезагрузки его нет', async ({ page }) => {
    await page.goto('/library/albums');
    await waitSynced(page);
    await expect(page.getByTestId('tab-albums')).toContainText('8');
    await page.getByTestId('library-albums').getByRole('link', { name: /Album 8/ }).click();
    await page.getByTestId('album-menu').click();
    await page.getByTestId('album-remove').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить' }).click();
    await expect(page).toHaveURL(/\/library\/albums$/);
    await expect(page.getByTestId('tab-albums')).toContainText('7');
    await expect(page.getByTestId('library-albums').getByRole('link', { name: /Album 8/ })).toHaveCount(0);

    await page.reload();
    await waitSynced(page);
    await expect(page.getByTestId('tab-albums')).toContainText('7');
    await expect(page.getByTestId('library-albums').getByRole('link', { name: /Album 8/ })).toHaveCount(0);
  });

  test('ошибка удаления: объект возвращается, показан toast', async ({ page, request }) => {
    await failDelete(request, true);
    await page.goto('/album/8');
    await waitSynced(page);
    await page.getByTestId('album-menu').click();
    await page.getByTestId('album-remove').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить' }).click();
    await expect(page.getByText('delete failed')).toBeVisible();
    await expect(page).toHaveURL(/\/album\/8$/);
    await expect(page.getByTestId('album-menu')).toBeVisible();
    await page.goto('/library/albums');
    await expect(page.getByTestId('tab-albums')).toContainText('8');
  });

  test('сервер меняет статус трека — бейдж обновляется без действий пользователя', async ({ page, request }) => {
    await page.goto('/album/1');
    await waitSynced(page);
    const row = page.getByTestId('track-row').first();
    await expect(row.getByRole('img', { name: 'Скачано' })).toBeVisible();
    await mutate(request, {
      entity: 'track',
      event: { album_id: 1, reason: 'dead_torrents', status: 'not_found', track_id: 1, type: 'track.status' },
      id: 1,
      patch: { status: 'not_found', status_reason: 'dead_torrents' },
    });
    await expect(row.getByRole('img', { name: 'Нет сидов' })).toBeVisible();
  });

  test('статус импорта артиста: повтор после неудачи', async ({ page, request }) => {
    await mutate(request, { entity: 'artist', id: 1, patch: { added_at: new Date().toISOString() } });
    await setImport(request, 1, { attempt: 8, error: 'MusicBrainz 503', max_attempts: 8, state: 'failed' });
    await page.goto('/artist/1');
    await waitSynced(page);
    const status = page.getByTestId('artist-import');
    await expect(status).toHaveAttribute('data-state', 'failed');
    await expect(status).toContainText('Сдались после 8 попыток');
    await status.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.getByText('Импорт запущен заново')).toBeVisible();
    await expect(page.getByTestId('artist-import')).toHaveAttribute('data-state', 'importing');
    expect((await mockLog(request)).some(l => l === 'POST /api/artists/1/import')).toBe(true);
  });

  test('нет такого альбома — «Не найдено» внутри оболочки', async ({ page }) => {
    await page.goto('/album/9999');
    await expect(page.getByRole('heading', { name: 'Не найдено' })).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });
});

test.describe('большая библиотека', () => {
  test.beforeEach(async ({ request }) => {
    await resetMock(request);
    await seedMock(request, { albums: 2000, artists: 200, tracks: 25_000 });
  });

  test('мгновенность: переход между экранами < 300 мс (цель 100 мс)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await waitSynced(page);
    await expect(page.getByTestId('home-recent')).toBeVisible();

    const toLibrary = await timeToAppear(page, '[data-testid=sidebar] a[href="/library"]', '[data-testid=tab-albums]');
    await expect(page.getByTestId('library-albums')).toBeVisible();
    const toTracks = await timeToAppear(page, '[data-testid=tab-tracks]', '[data-testid=library-tracks] [data-testid=track-row]');
    const toHome = await timeToAppear(page, '[data-testid=sidebar] a[href="/"]', '[data-testid=home-recent]');
    const toAlbum = await timeToAppear(page, '[data-testid=home-recent] a', '[data-testid=album-tracks]');
    // eslint-disable-next-line no-console -- цифры нужны для журнала шага
    console.log(`переходы, мс: библиотека ${toLibrary.toFixed(0)}, треки ${toTracks.toFixed(0)}, главная ${toHome.toFixed(0)}, альбом ${toAlbum.toFixed(0)}`);
    for (const ms of [toLibrary, toTracks, toHome, toAlbum]) expect(ms).toBeLessThan(300);
  });

  test('«назад» восстанавливает позицию прокрутки в длинном списке треков', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/library/tracks');
    await waitSynced(page);
    const main = page.getByRole('main');
    await expect(page.getByTestId('library-tracks')).toBeVisible();
    await main.evaluate(el => el.scrollTo(0, 20_000));
    await expect.poll(() => main.evaluate(el => el.scrollTop)).toBeGreaterThan(19_990);
    // Строка, целиком видимая в окне прокрутки: Playwright не должен прокручивать страницу ради клика
    // (в DOM есть и строки за краем окна — «запас» виртуализатора).
    const rows = page.getByTestId('library-tracks').getByTestId('track-row');
    const findVisible = () =>
      rows.evaluateAll(list => {
        const box = document.querySelector('main')!.getBoundingClientRect();
        return list.findIndex(r => {
          const b = r.getBoundingClientRect();
          return b.top >= box.top + 8 && b.bottom <= box.bottom - 8;
        });
      });
    // Виртуализатор дорисовывает строки после прокрутки.
    await expect.poll(findVisible).toBeGreaterThanOrEqual(0);
    await rows.nth(await findVisible()).getByRole('link').first().click();
    const before = 20_000;
    await expect(page).toHaveURL(/\/artist\/\d+$/);
    await page.goBack();
    await expect(page.getByTestId('library-tracks')).toBeVisible();
    await expect.poll(() => main.evaluate((el, expected) => Math.abs(el.scrollTop - expected), before)).toBeLessThan(2);
    // В DOM — только видимые строки, не 25 000.
    expect(await page.getByTestId('track-row').count()).toBeLessThan(80);
  });
});
