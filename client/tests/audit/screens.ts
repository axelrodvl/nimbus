// Каталог экранов для аудита интерфейса (шаг 49): как подготовить мок и привести страницу в нужное состояние.
// Используется матрицей скриншотов (`screens.spec.ts`) и проходом axe (`a11y.spec.ts`).
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  finishSearch,
  mutate,
  resetMock,
  seedAcquisition,
  seedMock,
  seedPlayer,
  seedSources,
  setImport,
  setSearch,
} from '../e2e/mock';

export type Ctx = { page: Page; request: APIRequestContext };

export type Screen = {
  name: string;
  /** Путь, который открывается после подготовки мока. */
  path: string;
  /** Подготовка мока до открытия страницы (после `resetMock`). */
  seed?: (ctx: Ctx) => Promise<void>;
  /** `resetMock` с авторизацией: экран входа. */
  auth?: boolean;
  /** Действия после загрузки: открыть диалог, ввести запрос, включить офлайн. */
  open?: (ctx: Ctx & { goOffline: () => Promise<void> }) => Promise<void>;
  /** Не ждать конца первой синхронизации (экран «первая синхронизация»). */
  noSync?: boolean;
  /** Плотный текст: дополнительно снимается на 360 в языках `de` и `ja`. */
  dense?: boolean;
};

const trackMenu = (page: Page, trackId: number) =>
  page.locator(`[data-track-id="${trackId}"]`).getByTestId('track-menu').click();

async function playAlbum(page: Page) {
  await page.getByTestId('play-album').first().click();
  await expect
    .poll(() => page.evaluate(() => (document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).paused))
    .toBe(false);
}

const SETTINGS = [
  'sources',
  'search',
  'musicbrainz',
  'playback',
  'storage',
  'performance',
  'jobs',
  'offline',
  'appearance',
  'about',
];
const DOWNLOAD_TABS = ['attention', 'searching', 'available', 'downloading', 'downloaded', 'torrents', 'device'];

/** Статус импорта показывается у артиста, добавленного только что (как в e2e библиотеки). */
const importable = (request: APIRequestContext) =>
  mutate(request, { entity: 'artist', id: 1, patch: { added_at: new Date().toISOString() } });

export const SCREENS: Screen[] = [
  { auth: true, name: 'login', path: '/login', noSync: true },
  { name: 'first-sync', noSync: true, path: '/', seed: ({ request }) => resetMock(request, { snapshotDelayMs: 5000 }) },
  { name: 'home-empty', path: '/', seed: ({ request }) => seedMock(request, { albums: 0, artists: 0, tracks: 0 }) },
  { name: 'home', path: '/' },
  { name: 'library-albums', path: '/library/albums' },
  { name: 'library-artists', path: '/library/artists' },
  { name: 'library-tracks', path: '/library/tracks' },
  { name: 'library-playlists', path: '/library/playlists' },
  { name: 'artist', path: '/artist/1' },
  {
    name: 'artist-importing',
    path: '/artist/1',
    seed: async ({ request }) => {
      await importable(request);
      await setImport(request, 1, { attempt: 2, max_attempts: 8, state: 'running' });
    },
  },
  {
    name: 'artist-import-failed',
    path: '/artist/1',
    seed: async ({ request }) => {
      await importable(request);
      await setImport(request, 1, { attempt: 8, error: 'MusicBrainz 503', max_attempts: 8, state: 'failed' });
    },
  },
  { name: 'album-ready', path: '/album/925', seed: ({ request }) => seedAcquisition(request) },
  { name: 'album-partial', path: '/album/922', seed: ({ request }) => seedAcquisition(request) },
  { name: 'album-searching', path: '/album/926', seed: ({ request }) => seedAcquisition(request) },
  { name: 'album-not-found', path: '/album/921', seed: ({ request }) => seedAcquisition(request) },
  { name: 'album-mixed', path: '/album/903', seed: ({ request }) => seedPlayer(request) },
  { name: 'playlist', path: '/playlist/1' },
  { name: 'favorites', path: '/playlist/favorites' },
  { name: 'search-empty', path: '/search' },
  {
    name: 'search-results',
    open: async ({ page }) => {
      await page.getByRole('searchbox').or(page.getByRole('combobox')).first().fill('artist');
      await page.waitForTimeout(600);
    },
    path: '/search',
  },
  {
    name: 'search-loading',
    open: async ({ page, request }) => {
      await setSearch(request, { delayMs: 60_000 });
      await page.getByRole('searchbox').or(page.getByRole('combobox')).first().fill('artist');
      await page.waitForTimeout(3200);
    },
    path: '/search',
  },
  {
    name: 'home-pending-add',
    open: async ({ page, request }) => {
      await setSearch(request, { addDelayMs: 60_000 });
      await page.getByRole('searchbox').or(page.getByRole('combobox')).first().fill('radiohead');
      await page.getByTestId('remote-album').first().getByRole('button').click();
      // Переход внутри приложения (боковая или нижняя панель — что видно в этой вёрстке; язык любой).
      await page.locator('a[href="/"]').filter({ visible: true }).first().click();
      await expect(page.getByTestId('pending-add').first()).toBeVisible();
    },
    path: '/search',
  },
  {
    name: 'search-error',
    open: async ({ page, request }) => {
      await setSearch(request, { failStatus: 502 });
      await page.getByRole('searchbox').or(page.getByRole('combobox')).first().fill('artist');
      await page.waitForTimeout(800);
    },
    path: '/search',
  },
  {
    name: 'search-offline',
    open: async ({ goOffline, page }) => {
      await goOffline();
      await page.getByRole('searchbox').or(page.getByRole('combobox')).first().fill('artist');
      await page.waitForTimeout(400);
    },
    path: '/search',
  },
  {
    name: 'catalog-artist',
    open: async ({ page }) => void (await expect(page.getByTestId('catalog-albums')).toBeVisible()),
    path: '/search/artist/a74b1b7f-71a5-4011-9441-d0b5e4122711',
  },
  {
    name: 'catalog-album',
    open: async ({ page }) => void (await expect(page.getByTestId('catalog-tracks')).toBeVisible()),
    path: '/search/album/b1392450-e666-3926-a536-22c65f834433',
  },
  {
    name: 'catalog-loading',
    open: async ({ page }) => void (await page.waitForTimeout(3200)),
    path: '/search/artist/a74b1b7f-71a5-4011-9441-d0b5e4122711',
    seed: ({ request }) => setSearch(request, { delayMs: 60_000 }),
  },
  {
    name: 'catalog-track-pending',
    open: async ({ page }) => {
      await page.getByTestId('catalog-track').first().getByTestId('remote-play').click();
      await expect(page.getByTestId('catalog-track').first().getByTestId('remote-play')).toHaveAttribute(
        'data-pending',
        'true',
      );
      await expect(page.getByTestId('play-pending')).toBeVisible();
    },
    path: '/search/album/b1392450-e666-3926-a536-22c65f834433',
  },
  {
    name: 'catalog-album-pending',
    open: async ({ page }) => {
      await page.getByTestId('catalog-play-album').click();
      await expect(page.getByTestId('catalog-play-album')).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByTestId('play-pending')).toBeVisible();
    },
    path: '/search/album/b1392450-e666-3926-a536-22c65f834433',
  },
  { name: 'sources', path: '/album/913/sources', seed: ({ request }) => seedSources(request) },
  {
    name: 'track-source-dialog',
    open: async ({ page }) => {
      await page.locator('[data-track-id="9132"]').getByTestId('needs-confirmation').click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
    path: '/album/913',
    seed: ({ request }) => seedSources(request),
  },
  {
    name: 'add-to-playlist-dialog',
    open: async ({ page }) => {
      await trackMenu(page, 1);
      await page
        .getByRole('menuitem')
        .filter({ hasText: /playlist/i })
        .first()
        .click();
      await expect(page.getByTestId('playlist-picker')).toBeVisible();
    },
    path: '/album/1',
  },
  {
    name: 'track-menu',
    open: async ({ page }) => trackMenu(page, 1),
    path: '/album/1',
  },
  {
    name: 'command-palette',
    open: async ({ page }) => {
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox').first().fill('track');
      await page.waitForTimeout(300);
    },
    path: '/',
  },
  ...SETTINGS.map(id => ({ dense: true, name: `settings-${id}`, path: `/settings/${id}` }) satisfies Screen),
  {
    dense: true,
    name: 'settings-jobs-stuck',
    path: '/settings/jobs',
    seed: ({ request }) => seedAcquisition(request, { stuck: true }),
  },
  { dense: true, name: 'downloads-empty', path: '/downloads/attention' },
  { dense: true, name: 'downloads-list', path: '/downloads', seed: ({ request }) => seedAcquisition(request) },
  ...DOWNLOAD_TABS.map(
    id =>
      ({
        dense: true,
        name: `downloads-${id}`,
        path: `/downloads/${id}`,
        seed: ({ request }) => seedAcquisition(request),
      }) satisfies Screen,
  ),
  {
    name: 'downloads-searching-done',
    path: '/downloads/available',
    seed: async ({ request }) => {
      await seedAcquisition(request);
      await finishSearch(request, 926, true);
    },
  },
  {
    name: 'player-full',
    open: async ({ page }) => {
      await playAlbum(page);
      await page
        .locator('[data-testid=player-expand]:visible, button[aria-label="Expand player"]:visible')
        .first()
        .click();
      await expect(page.getByTestId('full-player')).toHaveAttribute('aria-hidden', 'false');
    },
    path: '/album/903',
    seed: ({ request }) => seedPlayer(request),
  },
  {
    name: 'player-queue',
    open: async ({ page }) => {
      await playAlbum(page);
      await page
        .locator(
          '[data-testid=player-queue]:visible, [data-testid=mini-player] button[aria-label="Queue"]:visible, [data-testid=player-bar] button[aria-label="Queue"]:visible',
        )
        .first()
        .click();
      await expect(page.getByTestId('queue-panel')).toHaveAttribute('aria-hidden', 'false');
    },
    path: '/album/903',
    seed: ({ request }) => seedPlayer(request),
  },
  { name: 'not-found', path: '/no/such/page' },
  {
    name: 'album-missing',
    path: '/album/999999',
  },
  {
    name: 'offline-library',
    open: async ({ goOffline }) => goOffline(),
    path: '/library/albums',
  },
  {
    name: 'offline-downloads',
    open: async ({ goOffline }) => goOffline(),
    path: '/downloads/attention',
    seed: ({ request }) => seedAcquisition(request),
  },
  {
    name: 'offline-settings',
    open: async ({ goOffline }) => goOffline(),
    path: '/settings/sources',
  },
];

/** Подготавливает мок, открывает экран, дожидается синхронизации и действий экрана. */
export async function openScreen(screen: Screen, ctx: Ctx, goOffline: () => Promise<void>) {
  const { page, request } = ctx;
  await resetMock(request, { authRequired: screen.auth });
  await screen.seed?.(ctx);
  await page.goto(screen.path);
  if (!screen.noSync) {
    await page
      .getByTestId('sync-status')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 })
      .catch(() => undefined);
    await expect(page.getByTestId('library-loading')).toHaveCount(0, { timeout: 15_000 });
  }
  // Первая синхронизация в моке занимает доли секунды; без паузы офлайн-экраны снимаются до загрузки библиотеки.
  if (!screen.noSync) await page.waitForTimeout(800);
  await screen.open?.({ ...ctx, goOffline });
  // Шрифты и завершение переходов.
  await page.evaluate(() => document.fonts.ready);
  // Конечные анимации (появление экрана, переходы) доиграны: иначе в кадре и в axe «промежуточные» цвета.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(a => a.effect?.getTiming().iterations !== Infinity)
        .map(a => a.finished.catch(() => undefined)),
    ),
  );
  await page.waitForTimeout(150);
}

export { mutate };
