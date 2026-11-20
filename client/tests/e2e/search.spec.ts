import { expect, test, type Page } from '@playwright/test';
import { mockLog, mutate, resetMock, setSearch } from './mock';

const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
const searchRequests = async (request: Parameters<typeof mockLog>[0]) =>
  (await mockLog(request)).filter(l => l === 'GET /api/search').length;

/** Открывает поиск через боковую панель и вводит запрос. */
async function searchFor(page: Page, query: string) {
  await page.getByTestId('sidebar').getByRole('link', { name: 'Поиск' }).click();
  await page.getByRole('searchbox').fill(query);
}

test.describe('поиск', () => {
  test.beforeEach(async ({ request }) => resetMock(request));

  test('radiohead → секции → добавить альбом → «добавляется» → альбом в библиотеке без перезагрузки → отметка «В библиотеке»', async ({
    page,
    request,
  }) => {
    await setSearch(request, { addDelayMs: 800 });
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    await expect(page).toHaveURL(/\/search\?q=radiohead$/);
    await expect(page.getByTestId('search-artists')).toBeVisible();
    await expect(page.getByTestId('search-albums')).toBeVisible();
    await expect(page.getByTestId('search-tracks')).toBeVisible();

    const card = page.getByTestId('remote-album').filter({ hasText: 'OK Computer' });
    await card.getByRole('button', { name: 'Добавить в библиотеку' }).click();
    await expect(card.getByRole('button', { name: 'Добавляется…' })).toBeDisabled();
    // Дельта принесла альбом: кнопка превратилась в отметку «В библиотеке».
    await expect(card.getByText('В библиотеке')).toBeVisible();
    await expect(card.getByRole('link', { name: 'Открыть' })).toHaveCount(0);

    await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
    await expect(page.getByTestId('tab-albums')).toContainText('9');
    await expect(page.getByTestId('library-albums').getByText('OK Computer')).toBeVisible();
  });

  test('добавление артиста: на главной появляется карточка импортируемого артиста', async ({ page, request }) => {
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    const artist = page.getByTestId('remote-artist').filter({ hasText: 'Radiohead' }).first();
    await artist.getByRole('button', { name: 'Добавить в библиотеку' }).click();
    await expect(artist.getByText('В библиотеке')).toBeVisible();
    await page.getByTestId('sidebar').getByRole('link', { name: 'Главная' }).click();
    const card = page.getByTestId('home-recent').getByTestId('artist-card').filter({ hasText: 'Radiohead' });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('artist-import-badge')).toBeVisible();
    expect(await searchRequests(request)).toBe(1);
  });

  test('⌘K с экрана альбома → локальный трек → Enter → открыт его альбом', async ({ page }) => {
    await page.goto('/album/1');
    await expect(page.getByTestId('album-tracks')).toBeVisible();
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: 'Поиск артистов, альбомов и треков' });
    await expect(input).toBeFocused();
    await input.fill('Track 25');
    await expect(page.getByRole('option', { name: /Track 25/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/album\/3$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('«/» открывает палитру, Esc закрывает', async ({ page }) => {
    await page.goto('/');
    await waitSynced(page);
    await page.keyboard.press('/');
    await expect(page.getByRole('dialog', { name: 'Поиск' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('MusicBrainz недоступен: ошибки нет — статус «повторяем», локальные видны; поиск сам дожидается ответа', async ({
    page,
    request,
  }) => {
    await setSearch(request, { failStatus: 502 });
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'artist');
    await expect(page.getByText('MusicBrainz не ответил — повторяем запрос…')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Поиск не удался')).toHaveCount(0);
    await expect(page.getByTestId('search-local')).toContainText('Artist 1');
    await setSearch(request, {});
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('search-progress')).toHaveCount(0);
  });

  test('новый запрос сразу убирает результаты прежнего', async ({ page, request }) => {
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    await expect(page.getByTestId('search-albums')).toBeVisible();
    await setSearch(request, { delayMs: 3000 });
    await page.getByRole('searchbox').fill('artist');
    await expect(page.getByTestId('search-albums')).toHaveCount(0);
    await expect(page.getByTestId('search-progress')).toContainText('Ищем в MusicBrainz…');
  });

  test('уточнение запроса не убирает результаты: на каждом кадре блок на месте (ревью F08)', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    await expect(page.getByTestId('search-albums')).toBeVisible();
    await setSearch(request, { delayMs: 300 });
    // Проба в странице: на каждом кадре фиксируем, есть ли блок результатов и скелет.
    await page.evaluate(() => {
      const w = window as unknown as { __frames: { results: boolean; skeleton: boolean }[]; __stop: boolean };
      w.__frames = [];
      w.__stop = false;
      const tick = () => {
        w.__frames.push({
          results: !!document.querySelector('[data-testid=search-results]'),
          skeleton: !!document.querySelector('[data-testid=search-skeleton]'),
        });
        if (!w.__stop) requestAnimationFrame(tick);
      };
      tick();
    });
    const box = page.getByRole('searchbox');
    await box.click();
    await page.keyboard.type(' ok', { delay: 300 });
    await expect(page.getByTestId('search-results')).not.toHaveAttribute('aria-busy', 'true', { timeout: 10_000 });
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __frames: { results: boolean; skeleton: boolean }[]; __stop: boolean };
      w.__stop = true;
      return w.__frames;
    });
    // eslint-disable-next-line no-console -- цифры нужны для журнала
    console.log(
      `кадров ${frames.length}, без блока результатов ${frames.filter(f => !f.results).length}, со скелетом ${frames.filter(f => f.skeleton).length}`,
    );
    expect(frames.filter(f => !f.results)).toHaveLength(0);
    expect(frames.filter(f => f.skeleton)).toHaveLength(0);
  });

  test('добавленное сразу видно на главной и в библиотеке, ещё до ответа сервера', async ({ page, request }) => {
    await setSearch(request, { addDelayMs: 4000 });
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    const card = page.getByTestId('remote-album').filter({ hasText: 'OK Computer' });
    await card.getByRole('button', { name: 'Добавить в библиотеку' }).click();
    await page.getByTestId('sidebar').getByRole('link', { name: 'Главная' }).click();
    const pending = page.getByTestId('home-recent').getByTestId('pending-add').filter({ hasText: 'OK Computer' });
    await expect(pending).toContainText('Добавляется…');
    await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
    await expect(page.getByTestId('pending-strip')).toContainText('OK Computer');
    // Сервер ответил, дельта принесла альбом — заглушку сменила настоящая карточка.
    await expect(page.getByTestId('library-albums').getByText('OK Computer')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('pending-strip')).toHaveCount(0);
  });

  test('офлайн: только локальные результаты и пояснение', async ({ context, page }) => {
    await page.goto('/');
    await waitSynced(page);
    await context.setOffline(true);
    await searchFor(page, 'artist');
    await expect(page.getByTestId('search-offline')).toBeVisible();
    await expect(page.getByTestId('search-local')).toContainText('Artist 1');
    await expect(page.getByTestId('search-results')).toHaveCount(0);
  });

  test('«назад» со страницы альбома возвращает те же результаты без новых запросов к /api/search', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    const card = page.getByTestId('remote-album').filter({ hasText: 'OK Computer' });
    await card.getByRole('button', { name: 'Добавить в библиотеку' }).click();
    await expect(card.getByText('В библиотеке')).toBeVisible();
    await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
    await page.getByTestId('library-albums').getByText('OK Computer').click();
    await expect(page).toHaveURL(/\/album\/\d+$/);
    expect(await searchRequests(request)).toBe(1);
    await page.goBack();
    await page.goBack();
    await expect(page.getByTestId('search-albums')).toBeVisible();
    await expect(page.getByRole('searchbox')).toHaveValue('radiohead');
    expect(await searchRequests(request)).toBe(1);
  });
  test('как в музыкальном сервисе: артист → его альбомы → альбом → треки → нажатие на трек — играет (без добавления в библиотеку), когда нашёлся источник', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    await expect(page.getByTestId('search-artists')).toBeVisible();
    await page.getByTestId('remote-artist').filter({ hasText: 'Radiohead' }).first().getByRole('link').click();
    await expect(page).toHaveURL(/\/search\/artist\/a74b1b7f-/);
    await expect(page.getByRole('heading', { level: 1, name: 'Radiohead' })).toBeVisible();
    const albums = page.getByTestId('catalog-albums');
    await expect(albums.getByTestId('catalog-album')).toHaveCount(2);
    await albums.getByTestId('catalog-album').filter({ hasText: 'OK Computer' }).click();
    await expect(page).toHaveURL(/\/search\/album\/b1392450-/);
    const tracks = page.getByTestId('catalog-track');
    await expect(tracks).toHaveCount(2);

    const played = page.waitForResponse(r => r.url().endsWith('/api/play') && r.request().method() === 'POST');
    const row = tracks.filter({ hasText: 'Paranoid Android' });
    await row.getByTestId('remote-play').click();
    const { track_ids } = (await (await played).json()) as { track_ids: number[] };
    const id = track_ids[0]!;
    // Источник ищется: строка показывает ожидание, а в библиотеку трек не попал.
    await expect(row.getByTestId('remote-play')).toHaveAttribute('data-pending', 'true');
    await expect(row.getByRole('button', { name: 'Добавить в библиотеку' })).toBeVisible();
    expect((await mockLog(request)).filter(l => l === 'POST /api/library')).toEqual([]);
    await expect(page.getByTestId('play-pending')).toContainText('Paranoid Android');
    // Глобальный индикатор виден и на другом экране; заигравшее там сопровождается toast.
    await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
    await expect(page).toHaveURL(/\/library/);
    await expect(page.getByTestId('play-pending')).toContainText('Paranoid Android');
    await mutate(request, { entity: 'track', id, patch: { status: 'found' } });
    await expect(page.getByText('Играет «Paranoid Android»')).toBeVisible();
    await expect(page.getByTestId('play-pending')).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/search\/album\/b1392450-/);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const a = document.querySelector('[data-testid=player-audio]') as HTMLAudioElement | null;
          return a ? { paused: a.paused, src: a.getAttribute('src') ?? '' } : null;
        }),
      )
      .toEqual({ paused: false, src: expect.stringContaining(`/api/tracks/${id}/stream`) });
    await expect(page.locator('[data-testid=player-track]:visible').first()).toContainText('Paranoid Android');
    // Играет, но в библиотеке по-прежнему нет.
    await expect(row.getByRole('button', { name: 'Добавить в библиотеку' })).toBeVisible();

    await page.getByTestId('catalog-back').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Radiohead' })).toBeVisible();
  });
  test('ушёл с поиска вкладкой и вернулся вкладкой — тот же запрос, результаты и прокрутка, без нового запроса', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ height: 500, width: 1280 });
    await page.goto('/');
    await waitSynced(page);
    await searchFor(page, 'radiohead');
    await expect(page.getByTestId('search-tracks')).toBeVisible();
    const scroller = page.locator('[data-scroll-root]');
    await scroller.evaluate(el => el.scrollTo({ top: 400 }));
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(300);
    const top = await scroller.evaluate(el => el.scrollTop);
    await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
    await expect(page).toHaveURL(/\/library/);
    await page.getByTestId('sidebar').getByRole('link', { name: 'Поиск' }).click();
    await expect(page).toHaveURL(/\/search\?q=radiohead$/);
    await expect(page.getByRole('searchbox')).toHaveValue('radiohead');
    await expect(page.getByTestId('search-tracks')).toBeVisible();
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(top);
    expect(await searchRequests(request)).toBe(1);
  });
});
