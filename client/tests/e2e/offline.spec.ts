import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { OfflineE2eHook } from '../../src/lib/offline/e2e-hook';
import { mockLog, resetMock, seedOffline } from './mock';

// Движок офлайн-треков (шаг 46). Интерфейса скачивания ещё нет — действия идут через `window.__nimbus.offline`
// (хук есть только в e2e-сборке). Мок бэкенда отдаёт 5-секундный WAV (80 044 байта) с Range, ETag и If-Range.
// Альбом 923: треки 9231–9233; альбом 925: трек 9251 (перекодируемый, без Range).

type Hook = OfflineE2eHook;
declare global {
  interface Window {
    __nimbus?: { offline?: Hook };
  }
}

const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
const offlineState = (page: Page) => page.evaluate(() => window.__nimbus!.offline!.state());
const trackState = (page: Page, id: number) => page.evaluate(id => window.__nimbus!.offline!.state().files[id]?.state, id);

async function open(page: Page, path = '/library') {
  await page.goto(path);
  await waitSynced(page);
  await page.waitForFunction(() => Boolean(window.__nimbus?.offline));
}

const call = (page: Page, kind: 'pin' | 'unpin', what: 'track' | 'album', id: number) =>
  page.evaluate(([k, w, i]) => window.__nimbus!.offline![k](w, i), [kind, what, id] as const);

const allDone = (page: Page, ids: number[]) =>
  expect.poll(async () => (await Promise.all(ids.map(id => trackState(page, id)))).every(s => s === 'done'), { timeout: 30_000 }).toBe(true);

/** Имена файлов в OPFS (каталог `tracks`). */
const opfsList = (page: Page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = (await root.getDirectoryHandle('tracks', { create: true })) as unknown as { keys(): AsyncIterable<string> };
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
  await page.waitForFunction(() => Boolean(window.__nimbus?.offline));
}

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test('альбом закреплён → файлы скачаны → без сети трек играет из файла, перемотка работает, запросов к потоку нет', async ({
  context,
  page,
  request,
}, info) => {
  await seedOffline(request);
  await open(page);
  await swReady(page);
  const started = Date.now();
  await call(page, 'pin', 'album', 923);
  await allDone(page, [9231, 9232, 9233]);
  const seconds = (Date.now() - started) / 1000;
  info.annotations.push({
    description: `${((3 * 80_044) / 2 ** 20 / seconds).toFixed(2)} МБ/с (3 файла по 80 КБ, ${seconds.toFixed(2)} с)`,
    type: 'скорость скачивания на моке',
  });
  expect(await opfsList(page)).toEqual(['9231', '9232', '9233']);
  expect(await opfsHash(page, 9231)).toBe(await networkHash(page, 9231));

  await goOffline(context, page);
  const streamRequests: string[] = [];
  page.on('request', r => {
    if (/\/api\/tracks\/\d+\/stream/.test(r.url())) streamRequests.push(r.url());
  });
  await page.goto('/album/923');
  await expect(page.getByRole('heading', { name: 'Offline Test' })).toBeVisible();
  await page.getByTestId('play-album').first().click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await expect.poll(async () => (await audio(page)).currentTime).toBeGreaterThan(0.2);
  expect((await audio(page)).src).toMatch(/^blob:/);
  // Перемотка в середину.
  await page.evaluate(() => ((document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).currentTime = 2.5));
  await expect.poll(async () => (await audio(page)).currentTime).toBeGreaterThan(2.4);
  expect(streamRequests).toEqual([]);
});

test('перекодируемый трек (без Range) скачивается и играет офлайн с перемоткой, без запросов ?t=', async ({
  context,
  page,
  request,
}) => {
  await seedOffline(request);
  await open(page);
  await swReady(page);
  await call(page, 'pin', 'track', 9251);
  await allDone(page, [9251]);
  await goOffline(context, page);
  await page.goto('/album/925');
  await expect(page.getByRole('heading', { name: 'Offline Transcode' })).toBeVisible();
  await page.getByTestId('play-album').first().click();
  await expect.poll(async () => (await audio(page)).currentTime).toBeGreaterThan(0.2);
  expect((await audio(page)).src).toMatch(/^blob:/);
  await page.evaluate(() => ((document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).currentTime = 3));
  await expect.poll(async () => (await audio(page)).currentTime).toBeGreaterThan(2.9);
  await context.setOffline(false);
  expect((await mockLog(request)).filter(l => l.includes('9251/stream?t='))).toEqual([]);
});

test('обрыв загрузки посередине → докачка с места обрыва, файл побайтно равен исходному', async ({ page, request }) => {
  await seedOffline(request, { cut: { 9231: 30_000 } });
  await open(page);
  await call(page, 'pin', 'track', 9231);
  // Первая попытка обрывается, повтор через 5 с докачивает.
  await allDone(page, [9231]);
  expect(await opfsHash(page, 9231)).toBe(await networkHash(page, 9231));
  const log = await mockLog(request);
  const downloads = log.filter(l => l.includes('9231/stream?download=1'));
  expect(downloads.length).toBeGreaterThanOrEqual(2);
  expect(downloads.some(l => /bytes=\d+-/.test(l))).toBe(true);
});

test('перезагрузка страницы во время загрузки → после старта загрузка продолжается и завершается', async ({
  page,
  request,
}) => {
  await seedOffline(request, { delayMs: { 9231: 2500 } });
  await open(page);
  await call(page, 'pin', 'track', 9231);
  await expect.poll(() => trackState(page, 9231)).toBe('downloading');
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__nimbus?.offline));
  await allDone(page, [9231]);
  expect(await opfsList(page)).toEqual(['9231']);
});

test('снятие закрепления удаляет файлы и освобождает место', async ({ page, request }) => {
  await seedOffline(request);
  await open(page);
  await call(page, 'pin', 'album', 923);
  await allDone(page, [9231, 9232, 9233]);
  const before = (await offlineState(page)).usage.bytes;
  await call(page, 'unpin', 'album', 923);
  await expect.poll(() => opfsList(page)).toEqual([]);
  expect(Object.keys((await offlineState(page)).files)).toEqual([]);
  await expect.poll(async () => (await offlineState(page)).usage.bytes).toBeLessThanOrEqual(before);
});
