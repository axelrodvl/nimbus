import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { api, artistMbid, backendMemMiB, compose, sleep, token, waitFor, waitHealthy } from './stack-util';

// Длительный прогон (`just soak`, по умолчанию 30 минут, `SOAK_MINUTES=5` — короткий): клиент в headless-браузере
// непрерывно воспроизводит альбом и ходит по экранам, сервер параллельно импортирует артистов.
// Критерии: нет пауз воспроизведения > 2 с (кроме смены трека), память вкладки и бэкенда не растёт монотонно
// (сравнение «1/3 прогона» и «конец», допуск 15 %), нет ERROR/паник в логах, число потоков и открытых файлов стабильно.

const MINUTES = Number(process.env.SOAK_MINUTES ?? 30);
const DURATION_MS = MINUTES * 60_000;
const report: Record<string, unknown> = { minutes: MINUTES };

test.setTimeout(DURATION_MS + 15 * 60_000);

test.afterAll(() => {
  mkdirSync('test-results/load', { recursive: true });
  writeFileSync('test-results/load/soak.json', JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
});

const stage = (m: string) => process.stdout.write(`[soak ${new Date().toISOString()}] ${m}\n`);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);

/** Потоки и открытые файлы главного процесса бэкенда (ориентир утечки задач и дескрипторов). */
async function procStats() {
  const out = await compose([
    'exec',
    '-T',
    'nimbus',
    'sh',
    '-c',
    "echo $(ls /proc/1/fd | wc -l) $(grep Threads /proc/1/status | awk '{print $2}')",
  ]);
  const [fds, threads] = out.trim().split(' ').map(Number);
  return { fds: fds ?? NaN, threads: threads ?? NaN };
}

test('воспроизведение, навигация и импорт идут 30 минут без деградации', async ({ page }) => {
  stage('start');
  await waitHealthy();
  for (const i of [0, 1, 2]) {
    await api('/api/library', { method: 'POST', json: { type: 'artist', mbid: await artistMbid(i) } });
  }
  stage('artists added');
  await page.goto('/login');
  await page.getByLabel('Токен доступа').fill(token);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/);
  stage('logged in');
  await page.goto('/library/albums');
  const card = page.getByTestId('album-card').first();
  await expect(card).toBeVisible({ timeout: 120_000 });
  stage('library visible');
  await card.click();
  await expect(page.getByTestId('track-row').first().locator('[data-status]')).toHaveAttribute(
    'data-status',
    /found|ready/,
    { timeout: 120_000 },
  );

  stage('tracks found');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return (metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576;
  };
  const audio = () =>
    page.evaluate(() => {
      const a = document.querySelector('[data-testid=player-audio]') as HTMLAudioElement | null;
      return a ? { t: a.currentTime, paused: a.paused, ended: a.ended, src: a.currentSrc } : null;
    });
  const play = async () => {
    // Строки играют и пока файл только найден (`found`); кнопка альбома ждёт скачанных треков.
    await page
      .getByTestId('track-row')
      .first()
      .getByRole('button', { name: /^Играть:/ })
      .click({ timeout: 10_000 })
      .catch(() => undefined);
  };

  const start = Date.now();
  let nextArtist = 3;
  let nextImport = start;
  let nextNav = start;
  let lastProgress = { at: start, t: -1, src: '' };
  let stalls = 0;
  let maxStallMs = 0;
  let restarts = 0;
  const heapSamples: { at: number; v: number }[] = [];
  const memSamples: { at: number; v: number }[] = [];
  const procSamples: { at: number; fds: number; threads: number }[] = [];
  let nextSample = start;
  const routes = ['/library/albums', '/library/artists', '/library/tracks', '/downloads', '/settings'];
  let routeIx = 0;

  stage('loop');
  await play();
  while (Date.now() - start < DURATION_MS) {
    const now = Date.now();
    const a = await audio();
    if (Math.floor((now - start) / 10_000) !== Math.floor((lastProgress.at - start) / 10_000)) stage(`tick ${JSON.stringify(a)}`);
    if (a) {
      const progressed = a.src !== lastProgress.src || Math.abs(a.t - lastProgress.t) > 0.05;
      if (progressed) {
        const gap = now - lastProgress.at;
        // Пауза между «живыми» отсчётами; смена трека (src) и перезапуск альбома не считаются остановкой.
        if (a.src === lastProgress.src && !a.paused && gap > 2000) {
          stalls++;
          maxStallMs = Math.max(maxStallMs, gap);
        }
        lastProgress = { at: now, t: a.t, src: a.src };
      } else if (a.paused || a.ended) {
        // Альбом доиграл (треки по секунде): запускаем снова.
        restarts++;
        await play();
        lastProgress = { at: Date.now(), t: -1, src: '' };
      }
    }
    if (now >= nextNav) {
      const route = routes[routeIx++ % routes.length]!;
      stage(`nav ${route}`);
      await page.evaluate(r => {
        history.pushState(null, '', r);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, route);
      nextNav = now + 8000;
    }
    // Импорт идёт только в начале прогона: окна сравнения (1/3 и конец) должны мерить устойчивое состояние, а не рост библиотеки.
    if (now - start < DURATION_MS * 0.2 && now >= nextImport && nextArtist < Number(process.env.NIMBUS_FAKE_ARTISTS ?? 20)) {
      await api('/api/library', { method: 'POST', json: { type: 'artist', mbid: await artistMbid(nextArtist++) } });
      nextImport = now + 5000;
    }
    if (now >= nextSample) {
      heapSamples.push({ at: now - start, v: await heap() });
      memSamples.push({ at: now - start, v: await backendMemMiB() });
      procSamples.push({ at: now - start, ...(await procStats()) });
      nextSample = now + Math.max(10_000, DURATION_MS / 60);
    }
    await sleep(500);
  }

  // Сравнение окон: «1/3 прогона» (аналог 10-й минуты из 30) и последняя треть.
  const windowAvg = (xs: { at: number; v: number }[], from: number, to: number) =>
    avg(xs.filter(s => s.at >= from * DURATION_MS && s.at <= to * DURATION_MS).map(s => s.v));
  const cmp = (xs: { at: number; v: number }[]) => {
    const early = windowAvg(xs, 0.25, 0.4);
    const late = windowAvg(xs, 0.85, 1);
    return { early, late, growth: early > 0 ? late / early - 1 : 0 };
  };
  report.stalls = { count: stalls, maxMs: maxStallMs, albumRestarts: restarts };
  report.tabHeapMiB = cmp(heapSamples);
  report.backendMemMiB = cmp(memSamples);
  report.fds = { first: procSamples[0]?.fds, last: procSamples.at(-1)?.fds, max: Math.max(...procSamples.map(p => p.fds)) };
  report.threads = { first: procSamples[0]?.threads, last: procSamples.at(-1)?.threads, max: Math.max(...procSamples.map(p => p.threads)) };
  report.artistsImported = nextArtist;

  const logs = await compose(['logs', '--no-color', 'nimbus']);
  report.errorLines = (logs.match(/\bERROR\b|panicked at/g) ?? []).length;

  expect(report.errorLines).toBe(0);
  expect(stalls).toBe(0);
  expect((report.tabHeapMiB as { growth: number }).growth).toBeLessThan(0.15);
  expect((report.backendMemMiB as { growth: number }).growth).toBeLessThan(0.15);
  // Дескрипторы и потоки — не растут монотонно: конец не больше 1.15 × (максимум первой трети + 10).
  const firstThird = procSamples.filter(p => p.at <= DURATION_MS / 3);
  const baseFds = Math.max(...firstThird.map(p => p.fds));
  expect(procSamples.at(-1)!.fds).toBeLessThanOrEqual(baseFds * 1.15 + 10);
  await waitFor('queue drained', async () => (await api('/api/jobs?state=running')).status === 200, { timeoutMs: 10_000 });
});
