import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const search = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'search-radiohead.json'), 'utf8'));

// Серверные страницы читают данные из мока бэкенда (tests/mock-backend.mjs); поиск мокается в браузере.
async function mockSearch(page: Page) {
  await page.route('**/api/search*', route =>
    route.fulfill({ body: JSON.stringify(search), contentType: 'application/json' }),
  );
}

// Подменяет WebSocket `/api/ws`: возвращает функцию отправки событий «от сервера».
// В dev-режиме React монтирует провайдер дважды, поэтому сокетов может быть два — шлём во все живые.
async function mockLiveEvents(page: Page) {
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket('**/api/ws', ws => {
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
  });
  return {
    async send(event: object) {
      await expect.poll(() => sockets.size).toBeGreaterThan(0);
      for (const ws of sockets) {
        try {
          ws.send(JSON.stringify(event));
        } catch {
          sockets.delete(ws);
        }
      }
    },
  };
}

const row = (page: Page, title: string) => page.getByTestId('track-row').filter({ hasText: title });

test('добавление альбома из поиска → галочка → альбом в библиотеке', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/search?q=radiohead');
  const albums = page.locator('section[aria-labelledby="search-albums"]');
  const add = albums.getByRole('button', { name: 'Добавить в библиотеку' });
  await expect(add).toHaveCount(1);
  await add.click();
  await expect(albums.getByRole('button', { name: 'Добавлено в библиотеку' })).toBeVisible();
  await expect(page.getByText('Добавлено в библиотеку').first()).toBeVisible();

  await page.goto('/library?tab=albums');
  const card = page.getByTestId('library-albums').getByRole('link', { name: /OK Computer/ });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/album\/\d+$/);
  await expect(page.getByRole('heading', { name: 'OK Computer' })).toBeVisible();
  // 3 трека со спиннером «ищем»
  await expect(page.getByTestId('album-tracks').getByRole('img', { name: 'Ищем раздачи…' })).toHaveCount(3);
});

test('страница альбома: статусы треков и доступность воспроизведения', async ({ page }) => {
  await page.goto('/album/100');
  await expect(page.getByRole('heading', { name: 'The Bends' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Radiohead' }).first()).toHaveAttribute('href', '/artist/1');
  await expect(page.getByTestId('album-status-summary')).toHaveText(/1 найдено/);

  const adding = row(page, 'Planet Telex');
  await expect(adding.getByRole('img', { name: 'Ищем раздачи…' })).toBeVisible();
  await expect(adding.getByRole('button', { name: /Играть/ })).toBeDisabled();

  const found = row(page, 'High and Dry');
  await expect(found.getByRole('img', { name: 'Найдено, можно слушать' })).toBeVisible();
  await expect(found.getByRole('button', { name: /Играть/ })).toBeEnabled();

  const missing = row(page, 'Fake Plastic Trees');
  await expect(missing.getByRole('img', { name: 'Трек не найден в раздачах' })).toBeVisible();
  await expect(missing.getByRole('button', { name: /Играть/ })).toBeDisabled();

  // найденный трек можно запустить
  await found.getByRole('button', { name: /Играть/ }).click();
  await expect(page.getByTestId('player-play-pause').first()).toHaveAttribute('data-playing', 'true');
  await expect(page.locator('[data-testid=player-track]:visible').filter({ hasText: 'High and Dry' })).toBeVisible();
});

test('WS: track.status и job.progress обновляют бейджи без перезагрузки', async ({ page }) => {
  const live = await mockLiveEvents(page);
  await page.goto('/album/100');
  const adding = row(page, 'Planet Telex');
  await expect(adding.getByRole('img', { name: 'Ищем раздачи…' })).toBeVisible();

  await live.send({ album_id: 100, done: 3, stage: 'verifying', total: 7, type: 'job.progress' });
  await expect(adding.getByRole('img', { name: 'Проверяем раздачи 3/7' })).toBeVisible();
  await expect(page.getByTestId('album-progress')).toHaveText('Проверяем раздачи 3/7');

  await live.send({ album_id: 100, reason: null, status: 'ready', track_id: 1001, type: 'track.status' });
  await expect(adding.getByRole('img', { name: 'Скачано' })).toBeVisible();
  await expect(adding.getByRole('button', { name: /Играть/ })).toBeEnabled();

  await live.send({
    album_id: 100,
    reason: 'dead_torrents',
    status: 'not_found',
    track_id: 1001,
    type: 'track.status',
  });
  await expect(adding.getByRole('img', { name: 'Нет сидов' })).toBeVisible();

  // отложенный router.refresh() (серверное значение — `adding`) не затирает свежий live-статус
  await page.waitForTimeout(3500);
  await expect(adding.getByRole('img', { name: 'Нет сидов' })).toBeVisible();
});

test('альбом с отдельными треками: приглушённые строки и «+»', async ({ page }) => {
  await page.goto('/album/102');
  await expect(page.getByRole('heading', { name: 'Pablo Honey' })).toBeVisible();
  const inLibrary = row(page, 'Creep');
  const outside = row(page, 'Anyone Can Play Guitar');
  await expect(inLibrary.getByRole('img', { name: 'Найдено, можно слушать' })).toBeVisible();
  await expect(outside).toHaveClass(/opacity-55/);
  await expect(page.getByRole('button', { name: 'Добавить весь альбом' })).toBeVisible();

  await outside.getByRole('button', { name: 'Добавить в библиотеку' }).click();
  await expect(page.getByText('Добавлено в библиотеку').first()).toBeVisible();
  // после инвалидации кэша строка перестаёт быть приглушённой и получает статус
  await expect(outside.getByRole('img', { name: 'Ищем раздачи…' })).toBeVisible();
  await expect(outside).not.toHaveClass(/opacity-55/);
});

test('треки библиотеки: чипы статусов фильтруют список', async ({ page }) => {
  await page.goto('/library?tab=tracks');
  await expect(page.getByTestId('library-tracks')).toBeVisible();
  await expect(row(page, 'Planet Telex')).toBeVisible();

  await page.getByRole('link', { name: 'Готовы к прослушиванию' }).click();
  await expect(page).toHaveURL(/status=playable/);
  await expect(row(page, 'High and Dry')).toBeVisible();
  await expect(row(page, 'Creep')).toBeVisible();
  await expect(row(page, 'Planet Telex')).toHaveCount(0);

  await page.getByRole('link', { exact: true, name: 'Не найдены' }).click();
  await expect(row(page, 'Fake Plastic Trees')).toBeVisible();
  await expect(row(page, 'High and Dry')).toHaveCount(0);
});

test('альбомы библиотеки: «Показать ещё» подгружает следующую страницу', async ({ page }) => {
  await page.goto('/library?tab=albums');
  const items = page.getByTestId('library-albums').locator('> li:has(a)');
  await expect(items).toHaveCount(50);
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await expect.poll(() => items.count()).toBeGreaterThan(50);
  await expect(page.getByRole('button', { name: 'Показать ещё' })).toHaveCount(0);
});

test('страница артиста: сводка и сетка альбомов', async ({ page }) => {
  await page.goto('/artist/1');
  await expect(page.getByRole('heading', { level: 1, name: 'Radiohead' })).toBeVisible();
  await expect(page.getByTestId('artist-counts')).toContainText('в библиотеке');
  await expect(page.getByRole('link', { name: /The Bends/ })).toHaveAttribute('href', '/album/100');
});

test('удаление альбома из библиотеки с подтверждением', async ({ page }) => {
  await page.goto('/album/101');
  await expect(page.getByRole('heading', { name: 'Kid A' })).toBeVisible();
  await page.getByRole('button', { name: 'Удалить из библиотеки' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await expect(page).toHaveURL(/\/library\?tab=albums$/);
  await expect(page.getByTestId('library-albums')).toBeVisible();
  await expect(page.getByRole('link', { name: /Kid A/ })).toHaveCount(0);
});

test('несуществующий и сломанный ресурсы показывают аккуратные состояния', async ({ page }) => {
  await page.goto('/album/999999');
  await expect(page.getByText('Этого элемента нет в библиотеке.')).toBeVisible();

  await page.goto('/album/666');
  await expect(page.getByText('Что-то пошло не так')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
});

test('главная: недавно добавленные и готовые к прослушиванию', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Недавно добавленные' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Готово к прослушиванию' })).toBeVisible();
  await expect(page.getByTestId('track-row').filter({ hasText: 'High and Dry' })).toBeVisible();
});
