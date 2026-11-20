// Бюджеты производительности (шаг 49) на большой библиотеке: 5 000 альбомов / 60 000 треков.
// Каждое измерение — медиана из нескольких повторов; пороги — цель × 3 запаса для CI (см. шаг 49, п. 4).
// Фактические цифры печатаются в консоль (`PERF …`) — их переносят в Журнал.
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { mutate, resetMock, seedMock } from '../e2e/mock';

// На общем CI-раннере замеры времени шумят: PERF_SLACK (в CI — 2) умножает пороги по времени.
const slack = Number(process.env.PERF_SLACK ?? 1);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const report = (name: string, value: string) =>
  // eslint-disable-next-line no-console -- цифры нужны для журнала шага
  console.log(`PERF ${name}: ${value}`);

test.use({ viewport: { height: 900, width: 1440 } });
test.describe.configure({ timeout: 300_000 });

test.beforeEach(async ({ request }) => {
  await resetMock(request);
  await seedMock(request, { albums: 5000, artists: 500, tracks: 60_000 });
});

/** Первый заход: снимок скачан и сохранён в IndexedDB, главная готова. */
async function warm(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('home-recent')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('library-loading')).toHaveCount(0, { timeout: 120_000 });
}

/** Клик → появление условия (мс по `performance.now()` в странице). */
const clickToReady = (page: Page, click: string, ready: string) =>
  page.evaluate(
    ([clickSel, readySel]) =>
      new Promise<number>((resolve, reject) => {
        const t0 = performance.now();
        const el = document.querySelector<HTMLElement>(clickSel as string);
        if (!el) return reject(new Error(`нет элемента ${clickSel}`));
        el.click();
        const check = () => {
          if (document.querySelector(readySel as string)) resolve(performance.now() - t0);
          else if (performance.now() - t0 > 10_000) reject(new Error(`не появилось ${readySel}`));
          else requestAnimationFrame(check);
        };
        check();
      }),
    [click, ready],
  );

const NAV = (href: string) => `[data-testid=sidebar] a[href="${href}"]`;
/** Основные экраны: куда кликнуть и по чему узнать, что содержимое показано. */
const HOPS: { name: string; click: string; ready: string }[] = [
  { click: NAV('/library'), name: 'библиотека', ready: '[data-testid=library-albums] [data-testid=album-card]' },
  { click: '[data-testid=tab-tracks]', name: 'треки', ready: '[data-testid=library-tracks] [data-testid=track-row]' },
  { click: NAV('/downloads'), name: 'загрузки', ready: '[data-testid=acq-nav]' },
  { click: NAV('/settings'), name: 'настройки', ready: '[data-testid=settings-nav]' },
  { click: NAV('/search'), name: 'поиск', ready: 'main input' },
  { click: NAV('/'), name: 'главная', ready: '[data-testid=home-recent]' },
];

test('переход между основными экранами: медиана < 150 мс (цель 50 мс)', async ({ page }) => {
  await warm(page);
  const times: Record<string, number[]> = {};
  for (let round = 0; round < 5; round++) {
    for (const hop of HOPS) {
      const ms = await clickToReady(page, hop.click, hop.ready);
      (times[hop.name] ??= []).push(ms);
    }
  }
  const medians = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, median(v)]));
  report(
    'переходы, медиана мс',
    JSON.stringify(Object.fromEntries(Object.entries(medians).map(([k, v]) => [k, Math.round(v)]))),
  );
  for (const [name, ms] of Object.entries(medians)) expect(ms, `переход «${name}»`).toBeLessThan(150 * slack);
});

test('холодный старт с данными в IndexedDB: главная < 4 с (цель 1.5 с)', async ({ context, page }) => {
  await warm(page);
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const fresh = await context.newPage();
    await fresh.addInitScript(() => {
      const poll = () => {
        if (document.querySelector('[data-testid=home-recent]'))
          (window as unknown as { __ready: number }).__ready = performance.now();
        else requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
    await fresh.goto('/');
    await fresh.waitForFunction(() => (window as unknown as { __ready?: number }).__ready !== undefined, undefined, {
      timeout: 30_000,
    });
    times.push(await fresh.evaluate(() => (window as unknown as { __ready: number }).__ready));
    await fresh.close();
  }
  report('холодный старт, мс', `медиана ${Math.round(median(times))} (${times.map(Math.round).join(', ')})`);
  expect(median(times)).toBeLessThan(4000 * slack);
});

test('прокрутка 60 000 треков: кадров длиннее 50 мс за 3 с — не более 3', async ({ page }) => {
  await warm(page);
  await page.goto('/library/tracks');
  await expect(page.getByTestId('library-tracks').getByTestId('track-row').first()).toBeVisible();
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    runs.push(
      await page.evaluate(
        () =>
          new Promise<number>(resolve => {
            const main = document.querySelector('main') as HTMLElement;
            main.scrollTo(0, 0);
            let last = performance.now();
            const start = last;
            let long = 0;
            const step = (now: number) => {
              if (now - last > 50) long += 1;
              last = now;
              main.scrollTop += 90;
              if (now - start < 3000) requestAnimationFrame(step);
              else resolve(long);
            };
            requestAnimationFrame(step);
          }),
      ),
    );
  }
  report('прокрутка, длинных кадров за 3 с', runs.join(', '));
  expect(median(runs)).toBeLessThanOrEqual(3);
});

test('ввод в поиск: задержка до локальных результатов < 150 мс (цель 50 мс)', async ({ page }) => {
  await warm(page);
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: /Search artists/ });
  await expect(input).toBeFocused();
  const queries = ['Track 5', 'Track 12345', 'Album 4000', 'Track 59999', 'Artist 321'];
  const times: number[] = [];
  for (const q of queries) {
    const ms = await page.evaluate(
      q2 =>
        new Promise<number>((resolve, reject) => {
          const el = document.querySelector<HTMLInputElement>('input[role=combobox]')!;
          const t0 = performance.now();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
          setter.call(el, q2);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          const check = () => {
            if ([...document.querySelectorAll('[role=option]')].some(o => o.textContent?.includes(q2)))
              resolve(performance.now() - t0);
            else if (performance.now() - t0 > 5000) reject(new Error(`нет результатов для «${q2}»`));
            else requestAnimationFrame(check);
          };
          check();
        }),
      q,
    );
    times.push(ms);
  }
  report('поиск, мс', `медиана ${Math.round(median(times))} (${times.map(Math.round).join(', ')})`);
  expect(median(times)).toBeLessThan(150 * slack);
});

test('дельта из 100 изменений при открытом списке треков: самая длинная задача < 100 мс', async ({ page, request }) => {
  await warm(page);
  await page.goto('/library/tracks');
  await expect(page.getByTestId('library-tracks').getByTestId('track-row').first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __tasks: number[] };
    w.__tasks = [];
    new PerformanceObserver(list => list.getEntries().forEach(e => w.__tasks.push(e.duration))).observe({
      type: 'longtask',
      buffered: false,
    });
  });
  // Список «новые сверху»: меняем самые новые треки — они в открытом окне списка.
  for (let id = 60_000; id > 59_900; id--)
    await mutate(request, { entity: 'track', id, patch: { title: `Changed ${id}` } });
  await expect(page.getByTestId('track-row').filter({ hasText: 'Changed 60000' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(1500);
  const tasks = await page.evaluate(() => (window as unknown as { __tasks: number[] }).__tasks);
  const longest = Math.max(0, ...tasks);
  report('дельта 100 изменений, самая длинная задача мс', `${Math.round(longest)} (задач ≥ 50 мс: ${tasks.length})`);
  expect(longest).toBeLessThan(100 * slack);
});

test('память: прирост кучи после 50 переходов < 20 % (после принудительной сборки мусора)', async ({
  context,
  page,
}) => {
  await warm(page);
  const cdp: CDPSession = await context.newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    return ((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize;
  };
  const lap = async (laps: number) => {
    for (let i = 0; i < laps; i++) for (const hop of HOPS) await clickToReady(page, hop.click, hop.ready);
  };
  await lap(3); // прогрев: ленивые чанки, кэши
  const before = await heap();
  await lap(9); // 9 кругов × 6 экранов = 54 перехода
  const after = await heap();
  const growth = after / before - 1;
  report(
    'память, куча МБ',
    `${(before / 1e6).toFixed(1)} → ${(after / 1e6).toFixed(1)} (${(growth * 100).toFixed(1)} %)`,
  );
  expect(growth).toBeLessThan(0.2);
});

test('«Слушать» во вкладке «Треки»: в DOM ≤ 60 строк очереди, за 3 с воспроизведения нет задач > 100 мс', async ({
  page,
}) => {
  await warm(page);
  await page.goto('/library/tracks');
  const list = page.getByTestId('library-tracks');
  await expect(list.getByTestId('track-row').first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __tasks: number[] };
    w.__tasks = [];
    new PerformanceObserver(l => l.getEntries().forEach(e => w.__tasks.push(e.duration))).observe({
      type: 'longtask',
      buffered: false,
    });
  });
  await list
    .getByTestId('track-row')
    .first()
    .getByRole('button', { name: /Play|Играть/ })
    .click();
  await page.getByTestId('player-queue').click();
  await expect(page.getByTestId('queue-panel').getByTestId('queue-row').first()).toBeVisible();
  await page.waitForTimeout(3000);
  const rows = await page.locator('[data-testid=queue-row]').count();
  const tasks = await page.evaluate(() => (window as unknown as { __tasks: number[] }).__tasks);
  const longest = Math.max(0, ...tasks);
  report(
    'очередь 60 000 треков',
    `queue-row в DOM: ${rows}; длинных задач за 3 с: ${tasks.length}, самая длинная ${Math.round(longest)} мс`,
  );
  expect(rows).toBeLessThanOrEqual(60);
  expect(longest).toBeLessThan(100 * slack);
});
