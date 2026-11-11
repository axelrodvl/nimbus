import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

// Мок бэкенда (tests/mock-backend.mjs) отдаёт 5-секундный WAV с поддержкой Range.
// Альбом 103: Song One → Broken Format (503 ffmpeg_missing) → Song Two → Song Three (ready) → Not Yet (adding).

const playPause = (page: Page) => page.locator('[data-testid=player-play-pause]:visible');
const status = (page: Page) => page.locator('[data-testid=player-status]:visible');
const title = (page: Page) => page.locator('[data-testid=player-track]:visible').first();
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

async function playAlbum(page: Page) {
  await page.goto('/album/103');
  await expect(page.getByRole('heading', { name: 'Player Test' })).toBeVisible();
  await page.getByTestId('play-album').first().click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
}

const seekAudio = (page: Page, t: number) =>
  page.evaluate(x => ((document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).currentTime = x), t);

test('«Слушать альбом» играет первый играбельный трек, очередь без неиграбельных', async ({ page }) => {
  await playAlbum(page);
  await expect(title(page)).toContainText('Song One');
  await expect(playPause(page)).toHaveAttribute('data-playing', 'true');
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(0.2);
  expect((await state(page)).src).toContain('/api/tracks/1031/stream');
  // Полоска буфера и длительность из аудио
  await expect(page.getByTestId('player-buffered').first()).toBeAttached();
  await expect.poll(async () => (await state(page)).duration).toBeCloseTo(5, 0);

  await page.getByTestId('player-queue').click();
  const panel = page.getByTestId('queue-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('queue-row')).toHaveCount(4); // без «Not Yet»
  await expect(panel.getByTestId('queue-row').first()).toContainText('Song One');
  await expect(panel).not.toContainText('Not Yet');
});

test('Media Session: метаданные и обработчики', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Следующий' }).first().click();
  await expect(title(page)).toContainText('Broken Format');

  await expect(title(page).getByRole('link', { name: 'Broken Format' })).toHaveAttribute('href', '/album/103');
  await expect(title(page).getByRole('link', { name: 'Radiohead' })).toHaveAttribute('href', '/artist/1');
});

test('конец трека → следующий; 503 → тост и автопереход дальше', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Следующий' }).first().click();
  await expect(title(page)).toContainText('Broken Format');
  await page.getByRole('button', { name: 'Следующий' }).first().click();
  await expect(title(page)).toContainText('Song Two');
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(0.2);
  // быстро — предыдущий трек
  await page.getByRole('button', { name: 'Предыдущий' }).first().click();
  await expect(title(page)).toContainText('Broken Format');
  // дальше от начала трека — перемотка в начало
  await page.getByRole('button', { name: 'Следующий' }).first().click();
  await expect(title(page)).toContainText('Song Two');
  await seekAudio(page, 3.5);
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(3.4);
  await page.getByRole('button', { name: 'Предыдущий' }).first().click();
  await expect(title(page)).toContainText('Song Two');
  await expect.poll(async () => (await state(page)).currentTime).toBeLessThan(1.5);
});

test('повтор трека и повтор очереди', async ({ page }) => {
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
  await page.goto('/album/103');
  // Очередь из одного трека (кнопка в строке): после конца играть нечего
  await page
    .getByTestId('track-row')
    .filter({ hasText: 'Song Three' })
    .getByRole('button', { name: /Играть/ })
    .click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  await seekAudio(page, 4.7);
  await expect.poll(async () => (await state(page)).paused, { timeout: 8000 }).toBe(true);
  await expect(playPause(page)).not.toHaveAttribute('data-playing', 'true');
});

test('очередь: «Далее», переход по клику, удаление', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Следующий' }).first().click();
  await expect(title(page)).toContainText('Song Two');
  await page.getByTestId('player-seek').fill('3');
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(2.9);
  await expect(page.getByTestId('player-elapsed')).toHaveText(/0:0[3-4]/);
});

test('пробел в поле ввода не управляет плеером', async ({ page }) => {
  await playAlbum(page);
  // Клиентская навигация (без перезагрузки), чтобы воспроизведение не прервалось
  await page.getByRole('link', { name: 'Поиск' }).first().click();
  await expect(page).toHaveURL(/\/search$/);
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
    .poll(() => page.evaluate(() => (document.querySelector('[data-testid=player-audio]') as HTMLAudioElement).muted))
    .toBe(true);
});

test('очередь, громкость и позиция восстанавливаются после перезагрузки (на паузе)', async ({ page }) => {
  await playAlbum(page);
  await page.getByRole('slider', { name: 'Громкость' }).fill('40');
  await page.getByRole('button', { name: 'Следующий' }).first().click();
  await page.getByRole('button', { name: 'Следующий' }).first().click();
  await expect(title(page)).toContainText('Song Two');
  await seekAudio(page, 2);
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(1.9);
  await playPause(page).click(); // пауза: позиция перестаёт меняться
  await expect.poll(async () => (await state(page)).paused).toBe(true);
  await page.waitForTimeout(2300); // периодическое сохранение позиции

  await page.reload();
  await expect(title(page)).toContainText('Song Two');
  expect((await state(page)).paused).toBe(true);
  expect((await state(page)).src).toBeNull();
  await expect(page.getByRole('slider', { name: 'Громкость' })).toHaveValue('40');
  await expect(page.getByTestId('player-elapsed')).toHaveText(/0:0[1-3]/);

  // «Играть» загружает трек и продолжает с сохранённой позиции
  await playPause(page).click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  // позиция применяется после загрузки метаданных
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(1.5);
});

test('холодный старт: «Подключаемся к раздаче…» и отмена', async ({ page }) => {
  await page.route('**/api/tracks/1031/stream', async route => {
    await new Promise(r => setTimeout(r, 4000));
    await route.continue().catch(() => undefined);
  });
  await page.goto('/album/103');
  await page
    .getByTestId('track-row')
    .filter({ hasText: 'Song One' })
    .getByRole('button', { name: /Играть/ })
    .click();
  const st = status(page);
  await expect(st).toContainText('Подключаемся к раздаче');
  await page.getByRole('button', { name: 'Отменить' }).first().click();
  await expect(st).toBeHidden();
  await expect.poll(async () => (await state(page)).src).toBeNull();
  await expect(playPause(page)).not.toHaveAttribute('data-playing', 'true');
});

test('stream.progress показывает загрузку из торрента, пока трек не ready', async ({ page }) => {
  const live = await mockLiveEvents(page);
  await page.route('**/api/tracks/1031/stream', async route => {
    await new Promise(r => setTimeout(r, 3000));
    await route.continue().catch(() => undefined);
  });
  await page.goto('/album/103');
  await page
    .getByTestId('track-row')
    .filter({ hasText: 'Song One' })
    .getByRole('button', { name: /Играть/ })
    .click();
  await live.send({
    bytes_done: 34,
    bytes_total: 100,
    down_speed_bps: 1258291,
    peers: 12,
    track_id: 1031,
    type: 'stream.progress',
  });
  await expect(status(page)).toContainText('Загрузка из торрента: 34% · 12 пиров · 1.2 МБ/с');
  // Чужой трек игнорируется
  await live.send({
    bytes_done: 90,
    bytes_total: 100,
    down_speed_bps: 1,
    peers: 1,
    track_id: 777,
    type: 'stream.progress',
  });
  await expect(status(page)).toContainText('34%');
  // Трек стал ready — строка загрузки исчезает
  await live.send({ album_id: 103, reason: null, status: 'ready', track_id: 1031, type: 'track.status' });
  await expect(status(page)).not.toContainText('Загрузка из торрента');
});

test('live-статус: трек, ставший неиграбельным, пропускается', async ({ page }) => {
  const live = await mockLiveEvents(page);
  await playAlbum(page);
  await live.send({ album_id: 103, reason: 'no_match', status: 'not_found', track_id: 1034, type: 'track.status' });
  await live.send({ album_id: 103, reason: 'no_match', status: 'not_found', track_id: 1032, type: 'track.status' });
  await page.getByRole('button', { name: 'Следующий' }).first().click();
  await expect(title(page)).toContainText('Song Three');
});

const MOCK = `http://localhost:${process.env.MOCK_BACKEND_PORT ?? 4010}`;

test('перекодируемый трек: перемотка меняет src на ?t=, позиция = смещение + currentTime', async ({ page }) => {
  await page.goto('/album/105');
  await expect(page.getByRole('heading', { name: 'Transcode Test' })).toBeVisible();
  await page.getByTestId('play-album').first().click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  // Первый запрос — без `?t=`
  expect((await state(page)).src).toMatch(/\/api\/tracks\/1051\/stream$/);
  // Длительность берётся из трека (5 с), а не из потока
  await expect(page.getByTestId('player-seek')).toHaveAttribute('max', '5');

  await page.getByTestId('player-seek').fill('3');
  await expect.poll(async () => (await state(page)).src).toContain('/api/tracks/1051/stream?t=3');
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  // Показываемое время ≥ 3 с, хотя `currentTime` нового потока начинается с нуля
  await expect(page.getByTestId('player-elapsed')).toHaveText(/0:0[3-5]/);
  expect((await state(page)).currentTime).toBeLessThan(2.5);

  const log = (await (await page.request.get(`${MOCK}/__log`)).json()) as Array<{ path: string; query?: string }>;
  expect(log.some(r => r.path === '/api/tracks/1051/stream' && r.query === '?t=3.000')).toBe(true);
});
