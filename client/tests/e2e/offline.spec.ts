import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mockLog, resetMock, seedOffline } from './mock';

// Офлайн-треки (шаги 46–47): всё управление — через интерфейс. Мок бэкенда отдаёт 5-секундный WAV (80 044 байта)
// с Range, ETag и If-Range. Альбом 923: треки 9231–9233; альбом 925: трек 9251 (перекодируемый, без Range).

const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
const row = (page: Page, id: number) => page.locator(`[data-testid=track-row][data-track-id="${id}"]`);
const rowState = (page: Page, id: number) => row(page, id).getByTestId('track-offline');
const offlineButton = (page: Page) => page.getByTestId('offline-control').getByTestId('offline-button');

async function open(page: Page, path = '/library') {
  await page.goto(path);
  await waitSynced(page);
}

/** Пункт меню трека «Скачать на устройство» / «Удалить с устройства». */
async function trackMenuAction(page: Page, id: number, name: string | RegExp) {
  await row(page, id).getByTestId('track-menu').click();
  await page.getByRole('menuitem', { name }).click();
}

const allDone = (page: Page, ids: number[]) =>
  Promise.all(ids.map(id => expect(rowState(page, id)).toHaveAttribute('data-state', 'done', { timeout: 30_000 })));

/** Имена файлов в OPFS (каталог `tracks`). */
const opfsList = (page: Page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = (await root.getDirectoryHandle('tracks', { create: true })) as unknown as {
      keys(): AsyncIterable<string>;
    };
    const out: string[] = [];
    for await (const k of dir.keys()) out.push(k);
    return out.sort();
  });

/** SHA-256 файла из OPFS. */
const opfsHash = (page: Page, id: number) =>
  page.evaluate(async id => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('tracks');
    const file = await (await dir.getFileHandle(String(id))).getFile();
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  }, id);
/** SHA-256 того, что сервер отдаёт по сети (эталон). */
const networkHash = (page: Page, id: number) =>
  page.evaluate(async id => {
    const res = await fetch(`/api/tracks/${id}/stream`);
    const digest = await crypto.subtle.digest('SHA-256', await res.arrayBuffer());
    return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  }, id);

/** Service worker управляет страницей и оболочка закэширована (иначе перезагрузка без сети невозможна). */
async function swReady(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
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

const audio = (page: Page) =>
  page.evaluate(() => {
    const a = document.querySelector('[data-testid=player-audio]') as HTMLAudioElement;
    return { currentTime: a.currentTime, paused: a.paused, src: a.currentSrc || a.getAttribute('src') };
  });

async function goOffline(context: BrowserContext, page: Page) {
  await context.setOffline(true);
  await page.reload();
}

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test('альбом: «Скачать на устройство» → прогресс → «Скачано 3 из 3» → без сети играет из файла; соседний альбом приглушён с подсказкой', async ({
  context,
  page,
  request,
}, info) => {
  await seedOffline(request);
  await open(page, '/album/923');
  await swReady(page);
  const started = Date.now();
  const button = offlineButton(page);
  await expect(button).toHaveAttribute('data-state', 'none');
  await button.click();
  await expect(button).toHaveAttribute('data-state', /^(queued|downloading|done)$/);
  await expect(button).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(page.getByTestId('album-status-summary')).toContainText(/(КБ|МБ)/);
  const seconds = (Date.now() - started) / 1000;
  info.annotations.push({
    description: `${((3 * 80_044) / 2 ** 20 / seconds).toFixed(2)} МБ/с (3 файла по 80 КБ, ${seconds.toFixed(2)} с)`,
    type: 'скорость скачивания на моке',
  });
  await allDone(page, [9231, 9232, 9233]);
  expect(await opfsList(page)).toEqual(['9231', '9232', '9233']);
  expect(await opfsHash(page, 9231)).toBe(await networkHash(page, 9231));

  await goOffline(context, page);
  const streamRequests: string[] = [];
  page.on('request', r => {
    if (/\/api\/tracks\/\d+\/stream/.test(r.url())) streamRequests.push(r.url());
  });
  await expect(page.getByRole('heading', { name: 'Offline Test' })).toBeVisible();
  await expect(page.getByTestId('album-status-summary')).toContainText(/(КБ|МБ)/);
  await page.getByTestId('play-album').first().click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await expect.poll(async () => (await audio(page)).currentTime).toBeGreaterThan(0.2);
  expect((await audio(page)).src).toMatch(/^blob:/);
  // Перемотка в середину.
  await page.evaluate(
    () => ((document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).currentTime = 2.5),
  );
  await expect.poll(async () => (await audio(page)).currentTime).toBeGreaterThan(2.4);
  expect(streamRequests).toEqual([]);

  // Соседний нескачанный альбом: приглушён, трек не запускается, причина объяснена.
  await page.goto('/library/albums');
  await expect(page.locator('[data-testid=album-card] a', { hasText: 'Offline Transcode' })).toHaveAttribute(
    'data-dimmed',
    'true',
  );
  await expect(page.locator('[data-testid=album-card] a', { hasText: 'Offline Test' })).not.toHaveAttribute(
    'data-dimmed',
    /.*/,
  );
  await page.goto('/album/925');
  // Кнопка помечена `aria-disabled`, но нажимается (в этом её смысл), поэтому проверка доступности Playwright отключена.
  await page.locator('[data-track-id="9251"]').getByTestId('play-track').click({ force: true });
  await expect(page.getByText('Нет связи. Трек не скачан на устройство')).toBeVisible();
});

test('перекодируемый трек (без Range): пункт меню «Скачать на устройство», играет офлайн с перемоткой, без запросов ?t=', async ({
  context,
  page,
  request,
}) => {
  await seedOffline(request);
  await open(page, '/album/925');
  await swReady(page);
  await trackMenuAction(page, 9251, 'Скачать на устройство');
  await allDone(page, [9251]);
  await goOffline(context, page);
  await expect(page.getByRole('heading', { name: 'Offline Transcode' })).toBeVisible();
  await page.getByTestId('play-album').first().click();
  await expect.poll(async () => (await audio(page)).currentTime).toBeGreaterThan(0.2);
  expect((await audio(page)).src).toMatch(/^blob:/);
  await page.evaluate(
    () => ((document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).currentTime = 3),
  );
  await expect.poll(async () => (await audio(page)).currentTime).toBeGreaterThan(2.9);
  await context.setOffline(false);
  expect((await mockLog(request)).filter(l => l.includes('9251/stream?t='))).toEqual([]);
});

test('обрыв загрузки посередине → докачка с места обрыва, файл побайтно равен исходному', async ({ page, request }) => {
  await seedOffline(request, { cut: { 9231: 30_000 } });
  await open(page, '/album/923');
  await trackMenuAction(page, 9231, 'Скачать на устройство');
  // Первая попытка обрывается, повтор через 5 с докачивает.
  await allDone(page, [9231]);
  expect(await opfsHash(page, 9231)).toBe(await networkHash(page, 9231));
  const downloads = (await mockLog(request)).filter(l => l.includes('9231/stream?download=1'));
  expect(downloads.length).toBeGreaterThanOrEqual(2);
  expect(downloads.some(l => /bytes=\d+-/.test(l))).toBe(true);
});

test('перезагрузка страницы во время загрузки → после старта загрузка продолжается, о завершении — один toast', async ({
  page,
  request,
}) => {
  await seedOffline(request, { delayMs: { 9231: 2500 } });
  await open(page, '/album/923');
  await offlineButton(page).click();
  await expect(rowState(page, 9231)).toHaveAttribute('data-state', /^(downloading|queued)$/);
  await page.reload();
  await waitSynced(page);
  await expect(offlineButton(page)).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(page.getByText('«Offline Test» доступен офлайн')).toBeVisible();
  await expect(page.getByText('«Offline Test» доступен офлайн')).toHaveCount(1);
  expect(await opfsList(page)).toEqual(['9231', '9232', '9233']);
});

test('вкладка «На устройстве»: пауза → прогресс стоит → продолжить → завершилось; удаление освобождает место', async ({
  page,
  request,
}) => {
  await seedOffline(request, { delayMs: { 9231: 1500, 9232: 1500, 9233: 1500 } });
  // По одной загрузке за раз: после паузы уже идущая заканчивается, остальные ждут.
  await page.addInitScript(() => {
    if (!localStorage.getItem('nimbus:offline-settings')) {
      localStorage.setItem(
        'nimbus:offline-settings',
        JSON.stringify({ concurrency: 1, limitBytes: null, wifiOnly: false }),
      );
    }
  });
  await open(page, '/downloads/device');
  await expect(page.getByTestId('device-tab')).toBeVisible();
  await expect(page.getByTestId('device-queue')).toHaveText('Очередь пуста');
  await page.goto('/album/923');
  await offlineButton(page).click();
  await page.getByTestId('offline-queue-indicator').click();
  await expect(page).toHaveURL(/\/downloads\/device$/);
  await page.getByTestId('device-pause').click();
  await expect(page.getByTestId('device-queue')).toHaveText('Пауза');
  await expect(page.getByTestId('device-active')).toHaveCount(0, { timeout: 10_000 });
  const frozen = await page.getByTestId('device-pin').getByTestId('pin-meta').textContent();
  expect(frozen).not.toContain('Скачано 3 из 3');
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('device-pin').getByTestId('pin-meta')).toHaveText(frozen ?? '');
  expect(await opfsList(page)).not.toContain('9233');
  await page.getByTestId('device-pause').click();
  await expect(page.getByTestId('device-pin').getByTestId('pin-meta')).toContainText('Скачано 3 из 3', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('device-queue')).toHaveText('Очередь пуста');
  expect(await opfsList(page)).toEqual(['9231', '9232', '9233']);

  // Удалить закрепление: файлы пропали, на странице альбома кнопка вернулась в исходное состояние.
  await page.getByTestId('pin-remove').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить с устройства' }).click();
  await expect(page.getByTestId('device-pin')).toHaveCount(0);
  await expect.poll(() => opfsList(page)).toEqual([]);
  await page.goto('/album/923');
  await expect(offlineButton(page)).toHaveAttribute('data-state', 'none');
});

test('плейлист закреплён → в него добавлен трек в сети → трек скачался сам', async ({ page, request }) => {
  await seedOffline(request);
  await open(page, '/library/playlists');
  await page.getByTestId('new-playlist').click();
  await page.getByRole('textbox', { name: 'Название плейлиста' }).fill('Офлайн');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(/\/playlist\/3$/);
  const addTrack = async (id: number) => {
    await page.goto('/album/923');
    await waitSynced(page);
    await row(page, id).getByTestId('track-menu').click();
    await page.getByRole('menuitem', { name: 'Добавить в плейлист' }).click();
    await page
      .getByTestId('playlist-picker')
      .getByRole('button', { name: /Офлайн/ })
      .click();
  };
  await addTrack(9231);
  await page.goto('/playlist/3');
  await waitSynced(page);
  await expect(page.getByTestId('track-row')).toHaveCount(1);
  await offlineButton(page).click();
  await expect(offlineButton(page)).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  expect(await opfsList(page)).toEqual(['9231']);
  await addTrack(9232);
  await page.goto('/playlist/3');
  await expect.poll(() => opfsList(page), { timeout: 30_000 }).toEqual(['9231', '9232']);
  await expect(page.getByTestId('offline-summary')).toContainText('Скачано 2 из 2');
});

test('лимит места: «Нет места» и toast с переходом в настройки → лимит увеличен → загрузка продолжилась', async ({
  page,
  request,
}) => {
  await seedOffline(request);
  // Лимит — чуть больше одного файла: второй уже не помещается (меньше 1 ГБ служебно, ползунок в интерфейсе — от 1 ГБ).
  await page.addInitScript(() => {
    if (!localStorage.getItem('nimbus:offline-settings')) {
      localStorage.setItem(
        'nimbus:offline-settings',
        JSON.stringify({ concurrency: 1, limitBytes: 100_000, wifiOnly: false }),
      );
    }
  });
  await open(page, '/album/923');
  await offlineButton(page).click();
  const toast = page.getByText('На устройстве закончилось место — загрузка остановлена');
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Открыть настройки' }).click();
  await expect(page).toHaveURL(/\/settings\/offline$/);
  const slider = page.getByTestId('offline-limit');
  await slider.fill('2');
  await slider.blur();
  await page.goto('/album/923');
  await expect(offlineButton(page)).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
});

test('«Только скачанные» в библиотеке показывает ровно скачанные альбомы', async ({ page, request }) => {
  await seedOffline(request);
  await open(page, '/album/923');
  await offlineButton(page).click();
  await expect(offlineButton(page)).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await page.goto('/library/albums');
  await waitSynced(page);
  const all = await page.getByTestId('album-card').count();
  expect(all).toBeGreaterThan(1);
  await page.getByTestId('filter-downloaded').click();
  await expect(page).toHaveURL(/offline=1/);
  await expect(page.getByTestId('album-card')).toHaveCount(1);
  await expect(page.getByTestId('album-card')).toContainText('Offline Test');
  await expect(page.getByTestId('album-offline-badge')).toBeVisible();
  // Состояние в URL переживает перезагрузку.
  await page.reload();
  await expect(page.getByTestId('album-card')).toHaveCount(1);
});

test.describe('мобильный размер', () => {
  test.use({ viewport: { height: 844, width: 390 } });

  test('меню трека содержит скачивание, кнопки достижимы, вкладка «На устройстве» читаема', async ({
    page,
    request,
  }) => {
    await seedOffline(request);
    await open(page, '/album/923');
    await expect(offlineButton(page)).toBeInViewport();
    await trackMenuAction(page, 9231, 'Скачать на устройство');
    await allDone(page, [9231]);
    await page.goto('/downloads/device');
    await expect(page.getByTestId('device-tab')).toBeVisible();
    await expect(page.getByTestId('device-usage')).toBeVisible();
    await expect(page.getByTestId('device-pin')).toContainText('Offline One');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
