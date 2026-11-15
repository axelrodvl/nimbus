import { expect, test } from '@playwright/test';
import { api, artistMbid, compose, health, sleep, sql, token, waitFor, waitHealthy } from './stack-util';

// Отказы на полном стеке (`just resilience`): рестарт бэкенда во время импорта и закреплённой загрузки,
// остановка БД, остановка бэкенда при открытом клиенте, доля отказов внешних сервисов.
// Стек и каталог (20 артистов) поднимает scripts/load.sh; контейнерами управляем с хоста через docker compose.

const ALBUMS = 15;
const TRACKS = 12;
const num = async (q: string) => Number((await sql(q))[0]?.[0] ?? 0);
const runnable = () => num(`select count(*) from jobs where state='running' or (state='queued' and run_after <= now())`);
const addArtist = async (i: number) =>
  expect([200, 201, 202]).toContain(
    (await api('/api/library', { method: 'POST', json: { type: 'artist', mbid: await artistMbid(i) } })).status,
  );
const settled = (tracks: number) =>
  waitFor(
    `catalog of ${tracks} tracks imported`,
    async () => (await num('select count(*) from tracks')) >= tracks && (await runnable()) === 0,
    { timeoutMs: 10 * 60_000, intervalMs: 1000 },
  );

test.describe.configure({ mode: 'serial' });
test.setTimeout(15 * 60_000);

test('рестарт бэкенда во время импорта и закреплённой загрузки: всё доходит до конца', async () => {
  await waitHealthy();
  for (const i of [0, 1, 2]) await addArtist(i);
  await waitFor('import started', async () => (await num('select count(*) from jobs')) > 0, { intervalMs: 50 });
  await compose(['restart', 'nimbus']);
  await waitHealthy();
  await settled(3 * ALBUMS * TRACKS);

  // Закреплённая загрузка альбома (у первых альбомов есть раздача) + рестарт посреди неё.
  const albumId = await num(`select id from albums order by id limit 1`);
  expect((await api(`/api/albums/${albumId}/download`, { method: 'POST' })).status).toBe(200);
  await waitFor('pin queued', async () => (await num(`select count(*) from pinned_tracks`)) > 0, { intervalMs: 100 });
  await compose(['restart', 'nimbus']);
  await waitHealthy();
  await waitFor(
    'pins done',
    async () => (await num(`select count(*) from pinned_tracks where state <> 'done'`)) === 0,
    { timeoutMs: 5 * 60_000, intervalMs: 1000 },
  );
  expect(await num(`select count(*) from pinned_tracks where state='done'`)).toBeGreaterThan(0);
  expect(await num(`select count(*) from tracks where status='adding'`)).toBe(0);
});

test('клиент переживает рестарт бэкенда без перезагрузки страницы', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Токен доступа').fill(token);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/library/albums');
  await page.evaluate(() => ((window as unknown as { __alive: boolean }).__alive = true));
  const dot = (state: string) => page.locator(`span[data-state="${state}"][title]`).first();
  await expect(dot('open')).toBeAttached({ timeout: 30_000 });

  await compose(['restart', 'nimbus']);
  // «Нет связи» показывается, пока бэкенд недоступен, и снимается сама.
  await waitHealthy();
  await expect(dot('open')).toBeAttached({ timeout: 60_000 });
  expect(await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive)).toBe(true);
  await expect(page.getByTestId('album-card').first()).toBeVisible();
});

test('остановка БД на 20 с: бэкенд жив, API отвечает 503, очередь продолжает после возвращения', async () => {
  await waitHealthy();
  const restartsBefore = (await compose(['ps', '-q', 'nimbus'])).trim();
  await compose(['stop', 'db']);
  await waitFor(
    'API 503 while db is down',
    async () => (await api('/api/library/artists?limit=1')).status === 503,
    { timeoutMs: 60_000, intervalMs: 500 },
  );
  expect((await health()).status).not.toBe(0); // процесс отвечает
  await sleep(20_000);
  await compose(['start', 'db']);
  await waitHealthy(180_000);
  expect((await compose(['ps', '-q', 'nimbus'])).trim()).toBe(restartsBefore);
  const id = (await compose(['ps', '-q', 'nimbus'])).trim();
  const inspect = await new Promise<string>((res, rej) =>
    import('node:child_process').then(({ execFile }) =>
      execFile('docker', ['inspect', '-f', '{{.RestartCount}}', id], (e, out) => (e ? rej(e) : res(out.trim()))),
    ),
  );
  expect(inspect).toBe('0');

  // Очередь жива: новый артист обрабатывается до конца.
  const before = await num('select count(*) from tracks');
  await addArtist(3);
  await settled(before + ALBUMS * TRACKS);
});

test('остановка бэкенда на минуту: клиент работает локально и синхронизируется дельтой, не снимком', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Токен доступа').fill(token);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.goto('/library/albums');
  await expect(page.getByTestId('album-card').first()).toBeVisible({ timeout: 60_000 });
  const snapshots: string[] = [];
  const changes: string[] = [];
  page.on('request', r => {
    if (r.url().includes('/api/sync/snapshot')) snapshots.push(r.url());
    if (r.url().includes('/api/sync/changes')) changes.push(r.url());
  });

  await compose(['stop', 'nimbus']);
  await sleep(60_000);
  // Локальные данные на месте, навигация не ждёт сеть.
  await page.evaluate(() => {
    history.pushState(null, '', '/library/artists');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByTestId('album-card').or(page.locator('main')).first()).toBeVisible();

  await compose(['start', 'nimbus']);
  await waitHealthy(120_000);
  await addArtist(4);
  await waitFor('delta fetched', async () => changes.length > 0, { timeoutMs: 60_000, intervalMs: 500 });
  expect(snapshots).toEqual([]);
});

test('NIMBUS_FAKE_FAILURE_RATE=0.3: всё, что есть в раздачах, находится полностью, остальное — честно «нет раздач»', async () => {
  test.setTimeout(30 * 60_000);
  await compose(['up', '-d', '--force-recreate', 'nimbus'], {
    NIMBUS_FAKE_ARTISTS: '20',
    NIMBUS_FAKE_FAILURE_RATE: '0.3',
  });
  await waitHealthy(180_000);
  for (let i = 0; i < 20; i++) await addArtist(i);

  // Очередь пустеет целиком (повторы и отложенные задачи включены): ни импорт, ни поиск не застревают на случайных отказах.
  await waitFor(
    'queue fully drained',
    async () =>
      (await num('select count(*) from tracks')) >= 20 * ALBUMS * TRACKS &&
      (await num(`select count(*) from jobs where state in ('queued','running')`)) === 0,
    { timeoutMs: 25 * 60_000, intervalMs: 2000 },
  );
  expect(await num('select count(*) from albums')).toBe(20 * ALBUMS);
  expect(await num(`select count(*) from jobs where state='failed'`)).toBe(0);
  expect(await num(`select count(*) from tracks where status='adding'`)).toBe(0);

  // У первых 40 альбомов есть раздача (NIMBUS_FAKE_SWARM_ALBUMS): «найдено — значит доведено до конца», ни одного пропуска.
  const swarmAlbums = Number(process.env.NIMBUS_FAKE_SWARM_ALBUMS ?? 40);
  expect(await num(`select count(*) from tracks where status in ('found','ready')`)).toBe(swarmAlbums * TRACKS);
  // Остальное — «нет раздач», а не «не смогли спросить».
  expect(await num(`select count(*) from tracks where status='not_found' and status_reason <> 'no_torrents'`)).toBe(0);
});
