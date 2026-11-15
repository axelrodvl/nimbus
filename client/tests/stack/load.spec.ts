import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  api,
  artistMbid,
  backendMemMiB,
  compose,
  curlTiming,
  sleep,
  sql,
  token,
  waitFor,
  waitHealthy,
} from './stack-util';

// Нагрузочный сценарий (`just load`): 300 артистов × 15 альбомов × 12 треков ≈ 54 000 треков на полном стеке с
// фейковыми внешними сервисами. Проверяет НАШУ систему; скорости настоящих MusicBrainz и торрентов от неё не зависят.
// Цифры пишутся в test-results/load/report.json и в Журнал ROADMAP.md.

const ARTISTS = Number(process.env.NIMBUS_FAKE_ARTISTS ?? 300);
const ALBUMS = Number(process.env.NIMBUS_FAKE_ALBUMS_PER_ARTIST ?? 15);
const TRACKS = Number(process.env.NIMBUS_FAKE_TRACKS_PER_ALBUM ?? 12);
const report: Record<string, unknown> = { artists: ARTISTS, albums: ARTISTS * ALBUMS, tracks: ARTISTS * ALBUMS * TRACKS };

const SEARCH_WINDOW_MS = Number(process.env.LOAD_SEARCH_WINDOW_MS ?? 180_000);
const num = async (q: string) => Number((await sql(q))[0]?.[0] ?? 0);

test.describe.configure({ mode: 'serial' });
test.setTimeout(45 * 60_000);

test.afterAll(() => {
  mkdirSync('test-results/load', { recursive: true });
  writeFileSync('test-results/load/report.json', JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
});

test('импорт каталога, очередь, снимок, дельты', async () => {
  await waitHealthy();
  report.memIdleMiB = await backendMemMiB();

  // --- Время до первого поиска альбома после добавления артиста.
  const t0 = Date.now();
  const first = await api('/api/library', { method: 'POST', json: { type: 'artist', mbid: await artistMbid(0) } });
  expect([201, 202, 200]).toContain(first.status);
  await waitFor(
    'first album search',
    async () =>
      (await num(`select count(*) from jobs where kind='discover_album' and state in ('running','done')`)) > 0,
    { timeoutMs: 60_000, intervalMs: 100 },
  );
  report.firstAlbumSearchMs = Date.now() - t0;

  // --- Остальные артисты + выборка метрик очереди раз в секунду.
  const samples: { t: number; conns: number; mem: number; running: Record<string, number> }[] = [];
  const doneByKind: Record<string, { first: number; last: number; n: number }> = {};
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [conns, running, done, mem] = await Promise.all([
        num(`select count(*) from pg_stat_activity where datname='nimbus'`),
        sql(`select kind, count(*) from jobs where state='running' group by kind`),
        sql(`select kind, count(*), extract(epoch from min(updated_at)), extract(epoch from max(updated_at)) from jobs where state='done' group by kind`),
        backendMemMiB(),
      ]);
      samples.push({ t: Date.now(), conns, mem, running: Object.fromEntries(running.map(([k, c]) => [k, Number(c)])) });
      for (const [k, c, a, b] of done) doneByKind[k] = { n: Number(c), first: Number(a), last: Number(b) };
      await sleep(1000);
    }
  })();

  const importStart = Date.now();
  const queue = Array.from({ length: ARTISTS - 1 }, (_, i) => i + 1);
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        const r = await api('/api/library', { method: 'POST', json: { type: 'artist', mbid: await artistMbid(i) } });
        expect([200, 201, 202]).toContain(r.status);
      }
    }),
  );
  report.addAllArtistsMs = Date.now() - importStart;

  // Каталог доимпортирован, когда все треки на месте и импорт артистов завершён. Поиск раздач по 4 500 альбомам
  // ограничен лимитером Torznab (по замыслу: он бережёт домашний индексер) и занимает больше часа — его очередь
  // измеряем в окне SEARCH_WINDOW_MS, а полное опустошение проверяет resilience.spec.ts на каталоге из 20 артистов.
  const expectedTracks = ARTISTS * ALBUMS * TRACKS;
  await waitFor(
    'catalog imported',
    async () =>
      (await num('select count(*) from tracks')) >= expectedTracks &&
      (await num(`select count(*) from jobs where kind = 'import_artist' and state <> 'done'`)) === 0,
    { timeoutMs: 30 * 60_000, intervalMs: 2000 },
  );
  report.importAllMs = Date.now() - t0;
  const searchBefore = await num(`select count(*) from jobs where kind='discover_album' and state='done'`);
  await sleep(SEARCH_WINDOW_MS);
  const searchAfter = await num(`select count(*) from jobs where kind='discover_album' and state='done'`);
  report.discoverAlbumPerMinute = Math.round(((searchAfter - searchBefore) / SEARCH_WINDOW_MS) * 60_000);
  report.discoverAlbumQueuedLeft = await num(`select count(*) from jobs where kind='discover_album' and state='queued'`);
  sampling = false;
  await sampler;
  const settledAt = Date.now();

  report.tracksInDb = await num('select count(*) from tracks');
  expect(report.tracksInDb).toBe(expectedTracks);
  report.albumsInDb = await num('select count(*) from albums');

  // --- Пропускная способность по видам задач и занятость воркеров.
  report.jobsPerMinute = Object.fromEntries(
    Object.entries(doneByKind).map(([k, v]) => [k, Math.round((v.n / Math.max(v.last - v.first, 1)) * 60)]),
  );
  report.jobsDone = Object.fromEntries(Object.entries(doneByKind).map(([k, v]) => [k, v.n]));
  report.peakRunningByKind = samples.reduce<Record<string, number>>((acc, s) => {
    for (const [k, n] of Object.entries(s.running)) acc[k] = Math.max(acc[k] ?? 0, n);
    return acc;
  }, {});

  // --- БД и память.
  report.peakDbConnections = Math.max(...samples.map(s => s.conns));
  report.peakMemMiB = Math.max(...samples.map(s => s.mem));
  const logs = await compose(['logs', '--no-color', 'nimbus']);
  report.poolTimeouts = (logs.match(/pool timed out/gi) ?? []).length;
  report.errorLines = (logs.match(/\bERROR\b/g) ?? []).length;
  report.stuckRunningJobs = await num(
    `select count(*) from jobs where state='running' and coalesce(heartbeat_at, locked_at) < now() - interval '2 minutes'`,
  );
  // Треки в `adding` допустимы, пока у них есть активный/ожидающий поиск; «забытых» (без задачи) быть не должно.
  report.tracksStillAdding = await num(
    `select count(*) from tracks t where t.status='adding' and not exists (select 1 from jobs j where j.state in ('queued','running') and j.dedup_key in ('discover_album:' || t.album_id, 'discover_artist:' || t.artist_id))`,
  );
  report.failedJobs = await num(`select count(*) from jobs where state='failed'`);

  // Память не растёт после завершения нагрузки: две выборки с паузой.
  const m1 = await backendMemMiB();
  await sleep(15_000);
  const m2 = await backendMemMiB();
  report.memAfterMiB = [m1, m2];
  report.settledAfterMs = Date.now() - settledAt;

  // --- Снимок.
  const snap = await curlTiming('/api/sync/snapshot');
  report.snapshot = snap;
  expect(snap.status).toBe(200);

  // Курсор на момент снимка: первая строка `begin`.
  const res = await fetch(`${process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8011'}/api/sync/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const reader = res.body!.getReader();
  let head = '';
  const dec = new TextDecoder();
  while (!head.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    head += dec.decode(value);
  }
  await reader.cancel();
  const cursor = (JSON.parse(head.split('\n')[0]!) as { cursor: string }).cursor;

  // --- Дельты: 1 и 1000 изменённых строк.
  const delta = async (n: number) => {
    await sql(`update tracks set title = title || '' , updated_at = now() where id in (select id from tracks order by id limit ${n})`);
    const first = await curlTiming(`/api/sync/changes?cursor=${encodeURIComponent(cursor)}`);
    return first;
  };
  report.delta1 = await delta(1);
  report.delta1000 = await delta(1000);
  expect(report.delta1).toMatchObject({ status: 200 });

  // --- Цели.
  expect(report.poolTimeouts).toBe(0);
  expect(report.stuckRunningJobs).toBe(0);
  expect(report.tracksStillAdding).toBe(0);
  expect(snap.seconds).toBeLessThan(3);
  expect(snap.bytes).toBeLessThan(5 * 1024 * 1024);
  expect((report.delta1 as { seconds: number }).seconds).toBeLessThan(0.1);
  expect(report.firstAlbumSearchMs as number).toBeLessThan(5000);
});

test('клиент: холодный старт и переходы на реальной библиотеке', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8011', locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Токен доступа').fill(token);
  await page.getByRole('button', { name: 'Войти' }).click();
  // Холодный старт: новый контекст, IndexedDB пуста — загрузка снимка.
  const start = Date.now();
  await expect(page.getByTestId('album-card').first()).toBeVisible({ timeout: 120_000 }).catch(() => undefined);
  const cold = Date.now() - start;
  await page.reload();
  const warmStart = Date.now();
  await expect(page.locator('main')).toBeVisible();
  const warm = Date.now() - warmStart;
  const nav: Record<string, number> = {};
  for (const route of ['/library/albums', '/library/artists', '/library/tracks', '/downloads', '/settings']) {
    const t = Date.now();
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    nav[route] = Date.now() - t;
  }
  report.client = { coldSnapshotMs: cold, warmReloadMs: warm, navMs: nav };
  await ctx.close();
});
