import { expect, test, type Page } from '@playwright/test';
import { mockLog, mutate, resetMock, seedPlayer, setPlaylists } from './mock';

const waitSynced = (page: Page) => expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
const rows = (page: Page) => page.getByTestId('playlist-tracks').getByTestId('track-row');
const audioPaused = (page: Page) =>
  page.evaluate(() => (document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).paused);

async function trackMenu(page: Page, trackId: number) {
  await page.locator(`[data-track-id="${trackId}"]`).getByTestId('track-menu').click();
}

async function addToPlaylist(page: Page, trackId: number, playlist: string) {
  await trackMenu(page, trackId);
  await page.getByRole('menuitem', { name: 'Добавить в плейлист' }).click();
  await page.getByTestId('playlist-picker').getByRole('button', { name: new RegExp(playlist) }).click();
}

test.beforeEach(async ({ request }) => resetMock(request));

test('создать плейлист → добавить два трека → открыть → воспроизвести → убрать трек → удалить плейлист', async ({ page }) => {
  await page.goto('/library/playlists');
  await waitSynced(page);
  await expect(page.getByTestId('playlist-card')).toHaveCount(2);

  await page.getByTestId('new-playlist').click();
  await page.getByRole('textbox', { name: 'Название плейлиста' }).fill('Утро');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(/\/playlist\/3$/);
  await expect(page.getByTestId('playlist-title')).toHaveText('Утро');
  await expect(page.getByText('Плейлист пуст')).toBeVisible();

  await page.goto('/album/1');
  await waitSynced(page);
  await addToPlaylist(page, 1, 'Утро');
  await expect(page.getByText('Добавлено в «Утро»').first()).toBeVisible();
  await addToPlaylist(page, 2, 'Утро');

  await page.goto('/library/playlists');
  await waitSynced(page);
  // «Утро» последний раз пополнялся — первый в списке.
  await expect(page.getByTestId('playlist-card').first()).toContainText('Утро');
  await expect(page.getByTestId('playlist-card').first()).toContainText('2 трека');
  await page.getByTestId('playlist-card').first().click();
  await expect(rows(page)).toHaveCount(2);

  await page.getByTestId('play-album').first().click();
  await expect.poll(() => audioPaused(page)).toBe(false);

  await trackMenu(page, 1);
  await page.getByRole('menuitem', { name: 'Убрать из плейлиста' }).click();
  await expect(rows(page)).toHaveCount(1);

  await page.getByTestId('delete-playlist').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить плейлист' }).click();
  await expect(page).toHaveURL(/\/library\/playlists$/);
  await expect(page.getByTestId('playlist-card')).toHaveCount(2);
  await expect(page.getByText('Утро')).toHaveCount(0);

  // Серверное состояние совпало с клиентским: после перезагрузки плейлиста всё ещё нет.
  await page.reload();
  await waitSynced(page);
  await expect(page.getByTestId('playlist-card')).toHaveCount(2);
});

test('создание из диалога «Добавить в плейлист»: трек сразу в новом плейлисте', async ({ page }) => {
  await page.goto('/album/1');
  await waitSynced(page);
  await trackMenu(page, 3);
  await page.getByRole('menuitem', { name: 'Добавить в плейлист' }).click();
  await page.getByTestId('picker-new-playlist').click();
  await page.getByRole('textbox', { name: 'Название плейлиста' }).fill('Из диалога');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page.getByText('Добавлено в «Из диалога»').first()).toBeVisible();
  await page.goto('/playlist/3');
  await waitSynced(page);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute('data-track-id', '3');
});

test('повторное добавление: «уже в плейлисте», дубля нет', async ({ page, request }) => {
  await page.goto('/album/1');
  await waitSynced(page);
  await addToPlaylist(page, 1, 'Дорога'); // трек 1 уже в «Дороге»
  await expect(page.getByText('Уже в «Дорога»').first()).toBeVisible();
  expect((await mockLog(request)).filter(l => l.startsWith('POST /api/playlists/1/tracks'))).toHaveLength(0);
});

test('трек добавлен на «другом устройстве» — появляется в открытом плейлисте без перезагрузки', async ({ page, request }) => {
  await page.goto('/playlist/1');
  await waitSynced(page);
  await expect(rows(page)).toHaveCount(2);
  await mutate(request, {
    entity: 'playlist_track',
    row: { added_at: new Date().toISOString(), id: 99, playlist_id: 1, track_id: 5 },
  });
  await expect(rows(page)).toHaveCount(3);
  await mutate(request, { entity: 'playlist_track', remove: 99 });
  await expect(rows(page)).toHaveCount(2);
});

test('прослушать трек до порога — он появляется в «Избранном»', async ({ page, request }) => {
  // Треки альбома 903 длятся 5 с — порог прослушивания набирается быстро.
  await seedPlayer(request);
  await page.goto('/library/playlists');
  await waitSynced(page);
  await expect(page.getByTestId('playlist-card')).toHaveCount(2);
  await page.goto('/album/903');
  await waitSynced(page);
  await page.locator('[data-track-id="9031"]').getByTestId('play-track').click();
  await expect.poll(() => audioPaused(page)).toBe(false);
  await expect
    .poll(async () => (await mockLog(request)).filter(l => l === 'POST /api/tracks/9031/played').length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
  await page.getByTestId('tab-playlists').click();
  await expect(page.getByTestId('playlist-card').first()).toContainText('Любимое');
  await page.getByTestId('playlist-card').first().click();
  await expect(page.getByTestId('playlist-title')).toHaveText('Любимое');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('delete-playlist')).toHaveCount(0);
});

test('ошибка сервера при создании и добавлении: понятное сообщение, состояние не изменилось', async ({ page, request }) => {
  await page.goto('/album/1');
  await waitSynced(page);
  await setPlaylists(request, { failStatus: 500 });
  await addToPlaylist(page, 3, 'Фокус');
  await expect(page.getByText('playlist request failed').first()).toBeVisible();
  await page.goto('/playlist/2');
  await waitSynced(page);
  await expect(rows(page)).toHaveCount(1);
});

test('без сети плейлисты открываются, изменить нельзя — понятное сообщение', async ({ context, page }) => {
  await page.goto('/playlist/1');
  await waitSynced(page);
  await expect(rows(page)).toHaveCount(2);
  await context.setOffline(true);
  await page.getByTestId('sidebar').getByRole('link', { name: 'Библиотека' }).click();
  await page.getByTestId('tab-playlists').click();
  await expect(page.getByTestId('playlist-card')).toHaveCount(2);
  await page.getByTestId('playlist-card').filter({ hasText: 'Дорога' }).click();
  await expect(rows(page)).toHaveCount(2);

  await trackMenu(page, 1);
  await page.getByRole('menuitem', { name: 'Убрать из плейлиста' }).click();
  await expect(page.getByText('Нет сети — сейчас это изменить нельзя').first()).toBeVisible();
  await expect(rows(page)).toHaveCount(2);

  await page.getByTestId('delete-playlist').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить плейлист' }).click();
  await expect(page.getByText('Нет сети — сейчас это изменить нельзя').first()).toBeVisible();
  await expect(page.getByTestId('playlist-title')).toHaveText('Дорога');
});

test('плейлист играет из страницы плейлиста: очередь — его треки (плеер подключён)', async ({ page, request }) => {
  await seedPlayer(request);
  await page.goto('/playlist/1');
  await waitSynced(page);
  await page.locator('[data-track-id="1"]').getByTestId('play-track').click();
  await expect.poll(() => audioPaused(page)).toBe(false);
  await page.getByTestId('player-queue').click();
  await expect(page.getByTestId('queue-panel').getByTestId('queue-row')).toHaveCount(2);
});
