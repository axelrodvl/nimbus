import { expect, test, type Page } from '@playwright/test';
import { emit, mockLog, mutate, resetMock, seedPlayer } from './mock';

// Мок бэкенда отдаёт 5-секундный WAV с поддержкой Range.
// Альбом 903: Song One → Broken Format (503 ffmpeg_missing) → Song Two → Song Three (ready) → Not Yet (adding).

const playPause = (page: Page) => page.locator('[data-testid=player-play-pause]:visible');
const status = (page: Page) => page.locator('[data-testid=player-status]:visible');
const title = (page: Page) => page.locator('[data-testid=player-track]:visible').first();
const bar = (page: Page) => page.getByTestId('player-bar');
const state = (page: Page) =>
  page.evaluate(() => {
    const a = document.querySelector('[data-testid=player-audio]') as HTMLAudioElement;
    return {
      currentTime: a.currentTime,
      duration: a.duration,
      ended: a.ended,
      paused: a.paused,
      src: a.getAttribute('src'),
    };
  });

async function openAlbum(page: Page, id = 903, heading = 'Player Test') {
  await page.goto(`/album/${id}`);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

async function playAlbum(page: Page) {
  await openAlbum(page);
  await page.getByTestId('play-album').first().click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
}

const seekAudio = (page: Page, t: number) =>
  page.evaluate(x => ((document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).currentTime = x), t);

const rowPlay = (page: Page, name: string) =>
  page
    .getByTestId('track-row')
    .filter({ hasText: name })
    .getByRole('button', { name: /Играть/ });

test.beforeEach(async ({ request }) => {
  await resetMock(request);
  await seedPlayer(request);
});

test('«Слушать альбом» играет первый играбельный трек, очередь без неиграбельных', async ({ page }) => {
  await playAlbum(page);
  await expect(title(page)).toContainText('Song One');
  await expect(playPause(page)).toHaveAttribute('data-playing', 'true');
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(0.2);
  expect((await state(page)).src).toContain('/api/tracks/9031/stream');
  // Полоса буфера и длительность из аудио
  await expect(bar(page).getByTestId('player-buffered').first()).toBeAttached();
  await expect.poll(async () => (await state(page)).duration).toBeCloseTo(5, 0);

  await page.getByTestId('player-queue').click();
  const panel = page.getByTestId('queue-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('queue-row')).toHaveCount(4); // без «Not Yet»
  await expect(panel.getByTestId('queue-row').first()).toContainText('Song One');
  await expect(panel).not.toContainText('Not Yet');
});

test('Media Session: метаданные и состояние', async ({ page }) => {
  await playAlbum(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const m = navigator.mediaSession.metadata;
        return m && { album: m.album, artist: m.artist, title: m.title };
      }),
    )
    .toEqual({ album: 'Player Test', artist: 'Radiohead', title: 'Song One' });
  expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing');
});

test('пауза/продолжить, следующий/предыдущий и ссылки на альбом и артиста', async ({ page }) => {
  await playAlbum(page);
  await playPause(page).click();
  await expect(playPause(page)).not.toHaveAttribute('data-playing', 'true');
  expect((await state(page)).paused).toBe(true);
  await playPause(page).click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);

  // Broken Format в очереди есть (статус found), следующий за Song One
  await bar(page).getByRole('button', { name: 'Следующий' }).click();
  await expect(title(page)).toContainText('Broken Format');

  await expect(title(page).getByRole('link', { name: 'Broken Format' })).toHaveAttribute('href', '/album/903');
  await expect(title(page).getByRole('link', { name: 'Radiohead' })).toHaveAttribute('href', '/artist/900');
});

test('конец трека → следующий; 503 → сообщение, тост и автопереход дальше', async ({ page }) => {
  await playAlbum(page);
  await seekAudio(page, 4.6);
  // Song One закончился → Broken Format → 503: сообщение в плеере (на 2 с) и тост
  await expect(status(page)).toContainText('не установлен ffmpeg');
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Broken Format' })).toBeVisible();
  // через ~2 с переход к Song Two, и он играет
  await expect(title(page)).toContainText('Song Two', { timeout: 8000 });
  await expect.poll(async () => (await state(page)).paused).toBe(false);
});

test('prev: после 3 с — в начало трека, иначе предыдущий', async ({ page }) => {
  await playAlbum(page);
  const next = bar(page).getByRole('button', { name: 'Следующий' });
  const prev = bar(page).getByRole('button', { name: 'Предыдущий' });
  await next.click();
  await expect(title(page)).toContainText('Broken Format');
  await next.click();
  await expect(title(page)).toContainText('Song Two');
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(0.2);
  // быстро — предыдущий трек
  await prev.click();
  await expect(title(page)).toContainText('Broken Format');
  // дальше от начала трека — перемотка в начало
  await next.click();
  await expect(title(page)).toContainText('Song Two');
  await seekAudio(page, 3.5);
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(3.4);
  await prev.click();
  await expect(title(page)).toContainText('Song Two');
  await expect.poll(async () => (await state(page)).currentTime).toBeLessThan(1.5);
});

test('повтор трека', async ({ page }) => {
  await playAlbum(page);
  const repeat = page.getByTestId('player-repeat');
  await repeat.click(); // all
  await expect(repeat).toHaveAttribute('aria-pressed', 'true');
  await repeat.click(); // one
  await seekAudio(page, 4.7);
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 8000 }).toBeLessThan(2);
  await expect(title(page)).toContainText('Song One'); // тот же трек
  expect((await state(page)).paused).toBe(false);
});

test('конец очереди без повтора останавливает воспроизведение', async ({ page }) => {
  await openAlbum(page);
  // Очередь строится из списка, поэтому играем одиночный доступный трек через «Слушать» у последнего: Song Three — ready
  await rowPlay(page, 'Song Three').click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  await seekAudio(page, 4.7);
  await expect.poll(async () => (await state(page)).paused, { timeout: 8000 }).toBe(true);
  await expect(playPause(page)).not.toHaveAttribute('data-playing', 'true');
});

test('двойной клик по строке запускает трек', async ({ page }) => {
  await openAlbum(page);
  await page.getByTestId('track-row').filter({ hasText: 'Song Two' }).click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  await expect(title(page)).toContainText('Song Two');
  // недоступный трек приглушён и не запускается
  const notYet = page.getByTestId('track-row').filter({ hasText: 'Not Yet' });
  await expect(notYet.getByRole('button', { name: /Играть/ })).toBeDisabled();
});

test('очередь: «Далее», переход по клику, закрытие', async ({ page }) => {
  await playAlbum(page);
  await page.getByTestId('player-queue').click();
  const panel = page.getByTestId('queue-panel');
  await panel.getByTestId('queue-row').filter({ hasText: 'Song Three' }).getByRole('button').first().click();
  await expect(title(page)).toContainText('Song Three');

  await panel.getByTestId('queue-row').first().hover();
  await page.getByRole('button', { name: 'Закрыть очередь' }).click();
  // Панель уезжает за экран и недоступна для фокуса
  await expect(panel).toHaveAttribute('aria-hidden', 'true');
  await expect(panel).not.toBeInViewport();
});

test('очередь: перестановка и удаление', async ({ page }) => {
  await playAlbum(page);
  await page.getByTestId('player-queue').click();
  const panel = page.getByTestId('queue-panel');
  await expect(panel).toBeInViewport({ ratio: 1 }); // панель выехала
  const order = () =>
    panel.getByTestId('queue-row').evaluateAll(rows => rows.map(r => r.getAttribute('data-track-id')));
  expect(await order()).toEqual(['9031', '9034', '9032', '9033']);
  await panel.getByTestId('queue-row').filter({ hasText: 'Song Three' }).hover();
  await panel.getByRole('button', { name: 'Выше: Song Three' }).click();
  expect(await order()).toEqual(['9031', '9034', '9033', '9032']);
  await panel.getByTestId('queue-row').filter({ hasText: 'Broken Format' }).hover();
  await panel.getByRole('button', { name: 'Убрать из очереди: Broken Format' }).click();
  expect(await order()).toEqual(['9031', '9033', '9032']);
});

test('перемотка ползунком и горячие клавиши', async ({ page }) => {
  await playAlbum(page);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await state(page)).paused).toBe(true);
  await expect(playPause(page)).not.toHaveAttribute('data-playing', 'true'); // интерфейс уже отрисовал паузу
  await page.keyboard.press('Space');
  await expect.poll(async () => (await state(page)).paused).toBe(false);

  await seekAudio(page, 0.5);
  await page.keyboard.press('ArrowRight'); // +5 с → конец трека
  await expect(title(page)).toContainText('Broken Format', { timeout: 8000 });

  await page.keyboard.press('Shift+ArrowRight');
  await expect(title(page)).toContainText('Song Two');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(title(page)).toContainText('Broken Format');

  // Ползунок: значение в секундах
  await bar(page).getByRole('button', { name: 'Следующий' }).click();
  await expect(title(page)).toContainText('Song Two');
  await page.getByTestId('player-seek').fill('3');
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(2.9);
  await expect(page.getByTestId('player-elapsed')).toHaveText(/0:0[3-4]/);
});

test('пробел в поле ввода не управляет плеером', async ({ page }) => {
  await playAlbum(page);
  // Клиентская навигация (без перезагрузки), чтобы воспроизведение не прервалось
  await page.getByRole('link', { name: 'Поиск' }).first().click();
  await expect(page).toHaveURL(/\/search/);
  const input = page.getByRole('searchbox').or(page.getByRole('textbox')).first();
  await input.click();
  await page.keyboard.type('a b');
  expect((await state(page)).paused).toBe(false);
});

test('shuffle и громкость', async ({ page }) => {
  await playAlbum(page);
  const shuffle = page.getByTestId('player-shuffle');
  await shuffle.click();
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  // Текущий трек остаётся первым и играет
  await expect(title(page)).toContainText('Song One');
  await shuffle.click();
  await expect(shuffle).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('slider', { name: 'Громкость' }).fill('30');
  await expect
    .poll(() => page.evaluate(() => (document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).volume))
    .toBeCloseTo(0.3, 1);
  await page.getByRole('button', { name: 'Выключить звук' }).click();
  await expect
    .poll(() => page.evaluate(() => (document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).volume))
    .toBe(0);
});

test('очередь, громкость и позиция восстанавливаются после перезагрузки (на паузе)', async ({ page }) => {
  await playAlbum(page);
  await page.getByRole('slider', { name: 'Громкость' }).fill('40');
  const next = bar(page).getByRole('button', { name: 'Следующий' });
  await next.click();
  await next.click();
  await expect(title(page)).toContainText('Song Two');
  await seekAudio(page, 2);
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(1.9);
  await playPause(page).click(); // пауза: позиция перестаёт меняться
  await expect.poll(async () => (await state(page)).paused).toBe(true);

  await page.reload();
  await expect(title(page)).toContainText('Song Two');
  expect((await state(page)).paused).toBe(true);
  expect((await state(page)).src).toBeNull();
  await expect(page.getByRole('slider', { name: 'Громкость' })).toHaveValue('40');
  await expect(page.getByTestId('player-elapsed')).toHaveText(/0:0[1-3]/);

  // «Играть» загружает трек и продолжает с сохранённой позиции
  await playPause(page).click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(1.5);
});

test('холодный старт: «Подключаемся к раздаче…» и отмена', async ({ page, request }) => {
  await seedPlayer(request, { delayMs: { 9031: 4000 } });
  await openAlbum(page);
  await rowPlay(page, 'Song One').click();
  const st = status(page);
  await expect(st).toContainText('Подключаемся к раздаче');
  await page.getByRole('button', { name: 'Отменить' }).first().click();
  await expect(st).toBeHidden();
  await expect.poll(async () => (await state(page)).src).toBeNull();
  await expect(playPause(page)).not.toHaveAttribute('data-playing', 'true');
});

test('stream.progress показывает загрузку из торрента, пока трек не ready', async ({ page, request }) => {
  await seedPlayer(request, { delayMs: { 9031: 3000 } });
  await openAlbum(page);
  await rowPlay(page, 'Song One').click();
  await emit(request, {
    bytes_done: 34,
    bytes_total: 100,
    down_speed_bps: 1258291,
    peers: 12,
    track_id: 9031,
    type: 'stream.progress',
  });
  await expect(status(page)).toContainText('Загрузка из торрента: 34% · 12 пиров · 1.2 МБ/с');
  // Чужой трек игнорируется
  await emit(request, {
    bytes_done: 90,
    bytes_total: 100,
    down_speed_bps: 1,
    peers: 1,
    track_id: 777,
    type: 'stream.progress',
  });
  await expect(status(page)).toContainText('34%');
  // Трек стал ready — строка загрузки исчезает
  await mutate(request, { entity: 'track', id: 9031, patch: { status: 'ready' } });
  await expect(status(page)).not.toContainText('Загрузка из торрента');
});

test('live-статус: трек, ставший недоступным, пропускается', async ({ page, request }) => {
  await playAlbum(page);
  await expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
  await mutate(request, { entity: 'track', id: 9034, patch: { status: 'not_found' } });
  await mutate(request, { entity: 'track', id: 9032, patch: { status: 'not_found' } });
  // Строка приглушена, играть её нельзя
  await expect(
    page
      .getByTestId('track-row')
      .filter({ hasText: 'Song Two' })
      .getByRole('button', { name: /Играть/ }),
  ).toBeDisabled();
  await bar(page).getByRole('button', { name: 'Следующий' }).click();
  await expect(title(page)).toContainText('Song Three');
});

test('перекодируемый трек: перемотка меняет src на ?t=, позиция = смещение + currentTime', async ({
  page,
  request,
}) => {
  await openAlbum(page, 905, 'Transcode Test');
  await page.getByTestId('play-album').first().click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  // Первый запрос — без `?t=`
  expect((await state(page)).src).toMatch(/\/api\/tracks\/9051\/stream$/);
  // Длительность берётся из трека (5 с), а не из потока
  await expect(page.getByTestId('player-seek')).toHaveAttribute('max', '5');

  await page.getByTestId('player-seek').fill('3');
  await expect.poll(async () => (await state(page)).src).toContain('/api/tracks/9051/stream?t=3');
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  // Показываемое время ≥ 3 с, хотя `currentTime` нового потока начинается с нуля
  await expect(page.getByTestId('player-elapsed')).toHaveText(/0:0[3-5]/);
  expect((await state(page)).currentTime).toBeLessThan(2.5);

  expect(await mockLog(request)).toContain('GET /api/tracks/9051/stream?t=3.000');
});

test('прослушивание засчитывается один раз, следующий трек предзагружается', async ({ page, request }) => {
  await playAlbum(page);
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(2.7);
  await expect
    .poll(async () => (await mockLog(request)).filter(l => l === 'POST /api/tracks/9031/played').length)
    .toBe(1);
  // Broken Format — `found`, а предзагрузка включена в настройках
  expect(await mockLog(request)).toContain('POST /api/tracks/9034/prefetch');
  await page.waitForTimeout(800);
  expect((await mockLog(request)).filter(l => l === 'POST /api/tracks/9031/played')).toHaveLength(1);
});

test('навигация не прерывает звук: пройти 5 экранов — время монотонно растёт, элемент аудио тот же', async ({
  page,
}) => {
  await playAlbum(page);
  await page.evaluate(() => {
    const a = document.querySelector('[data-testid=player-audio]') as HTMLAudioElement & { __same?: boolean };
    a.__same = true;
  });
  const times: number[] = [(await state(page)).currentTime];
  const sample = async () => times.push((await state(page)).currentTime);
  for (const link of [/Главная/, /Библиотека/, /Поиск/, /Главная/]) {
    await page.getByRole('link', { name: link }).first().click();
    await sample();
    await page.waitForTimeout(250);
  }
  await page.getByRole('main').getByRole('link').first().click(); // экран альбома или артиста
  await sample();
  await page.goBack();
  await sample();
  // Один элемент на всю вкладку; время только растёт (до конца трека 5 с — берём первые секунды)
  expect(
    await page.evaluate(
      () => (document.querySelector('[data-testid=player-audio]') as HTMLAudioElement & { __same?: boolean }).__same,
    ),
  ).toBe(true);
  expect(await page.locator('[data-testid=player-audio]').count()).toBe(1);
  const playing = times.filter(t => t < 4.5);
  for (let i = 1; i < playing.length; i++) expect(playing[i]).toBeGreaterThanOrEqual(playing[i - 1]);
  await expect(title(page)).toBeVisible();
});

test.describe('мобильный размер', () => {
  test.use({ hasTouch: true, viewport: { height: 844, width: 390 } });

  test('мини-плеер → полноэкранный → смахивание вниз закрывает; мини-плеер не перекрывает панель вкладок', async ({
    page,
  }) => {
    await playAlbum(page);
    const mini = page.getByTestId('mini-player');
    await expect(mini).toBeVisible();
    await expect(page.getByTestId('player-bar')).toBeHidden();
    const tabs = page.getByTestId('mobile-tab-bar');
    const [miniBox, tabsBox] = [await mini.boundingBox(), await tabs.boundingBox()];
    expect(miniBox!.y + miniBox!.height).toBeLessThanOrEqual(tabsBox!.y + 1);
    expect(tabsBox!.y + tabsBox!.height).toBeLessThanOrEqual(844 + 1);

    await page.getByTestId('player-expand').click();
    const full = page.getByTestId('full-player');
    await expect(full).toHaveAttribute('aria-hidden', 'false');
    await expect(page.getByTestId('full-player-title')).toContainText('Song One');
    // Смахивание вниз: touchstart → touchmove на 200 px → touchend
    await full.evaluate(el => {
      const touch = (y: number) => new Touch({ clientX: 100, clientY: y, identifier: 1, target: el });
      const fire = (type: string, y: number, end = false) =>
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            changedTouches: [touch(y)],
            touches: end ? [] : [touch(y)],
          }),
        );
      fire('touchstart', 200);
      fire('touchmove', 400);
      fire('touchend', 400, true);
    });
    await expect(full).toHaveAttribute('aria-hidden', 'true');
    await expect(mini).toBeVisible();
  });
});
