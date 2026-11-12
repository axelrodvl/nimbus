import { expect, test, type Page } from '@playwright/test';

// Альбом 103 (мок): Song One → (Broken Format пропускается) → Song Two → Song Three.

const fullTitle = (page: Page) => page.getByTestId('full-player-title');

async function openFullPlayer(page: Page) {
  await page.goto('/album/103');
  await page.getByTestId('play-album').first().click();
  await page.locator('[data-testid=player-expand]:visible').first().click();
  await expect(fullTitle(page)).toContainText('Song One');
}

// Синтетический жест: touchstart в (x0, y0) и touchend в (x1, y1) на элементе.
async function swipe(page: Page, testId: string, [x0, y0]: [number, number], [x1, y1]: [number, number]) {
  await page.getByTestId(testId).evaluate(
    (el, [x0, y0, x1, y1]) => {
      const touch = (x: number, y: number) => new Touch({ clientX: x, clientY: y, identifier: 1, target: el });
      const fire = (type: string, x: number, y: number, end = false) =>
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            changedTouches: [touch(x, y)],
            touches: end ? [] : [touch(x, y)],
          }),
        );
      fire('touchstart', x0, y0);
      fire('touchend', x1, y1, true);
    },
    [x0, y0, x1, y1],
  );
}

test.use({ hasTouch: true, viewport: { height: 844, width: 390 } });

test('свайп влево по обложке — следующий трек, вправо — предыдущий', async ({ page }) => {
  await openFullPlayer(page);

  // Broken Format (503) сам пропускается, поэтому «вперёд» ведёт к Song Two.
  await swipe(page, 'full-player-cover', [250, 300], [100, 305]);
  await expect(fullTitle(page)).toContainText('Song Two');
  await swipe(page, 'full-player-cover', [250, 300], [100, 305]);
  await expect(fullTitle(page)).toContainText('Song Three');

  await swipe(page, 'full-player-cover', [100, 300], [250, 295]);
  await expect(fullTitle(page)).toContainText('Song Two');
});

test('короткий или преимущественно вертикальный свайп трек не меняет', async ({ page }) => {
  await openFullPlayer(page);

  await swipe(page, 'full-player-cover', [200, 300], [170, 300]); // < 50 px
  await swipe(page, 'full-player-cover', [250, 200], [150, 400]); // больше по вертикали
  await expect(fullTitle(page)).toContainText('Song One');
});

test('текст трека при смене анимируется в сторону свайпа', async ({ page }) => {
  await openFullPlayer(page);
  const block = page
    .locator('[data-testid=full-player-title]')
    .locator('xpath=ancestor::div[contains(@class,"animate-track")][1]');

  await expect(block).toHaveClass(/animate-track-next/);
  await swipe(page, 'full-player-cover', [100, 300], [250, 300]); // вправо — «назад»
  await expect(block).toHaveClass(/animate-track-prev/);
  await swipe(page, 'full-player-cover', [250, 300], [100, 300]);
  await expect(block).toHaveClass(/animate-track-next/);
});

test('строка качества плавно гаснет и появляется при смене трека', async ({ page }) => {
  await page.route('**/api/tracks/*/audio-info', async route => {
    const id = route
      .request()
      .url()
      .match(/tracks\/(\d+)\//)![1];
    // Второй трек отвечает с задержкой, чтобы застать состояние «гаснет».
    if (id === '1032') await new Promise(r => setTimeout(r, 800));
    await route.fulfill({
      json: {
        bit_depth: 16,
        bitrate_kbps: null,
        channels: 'stereo',
        codec: id === '1031' ? 'flac' : 'mp3',
        ext: 'flac',
        sample_rate: 44100,
        transcoded: false,
      },
    });
  });

  await openFullPlayer(page);
  const span = page.getByTestId('audio-quality').locator('span');
  const opacity = () => span.evaluate(el => getComputedStyle(el).opacity);

  await expect(span).toContainText('FLAC');
  await expect.poll(opacity).toBe('1');

  await swipe(page, 'full-player-cover', [250, 300], [100, 300]);
  // Пока грузится новый ответ, старый текст остаётся в DOM и гаснет, а не исчезает мгновенно.
  await expect(span).toContainText('FLAC');
  await expect(span).toHaveClass(/opacity-0/);
  // После ответа — новый текст и полная видимость.
  await expect(span).toContainText('MP3');
  await expect(span).toHaveClass(/opacity-100/);
  await expect.poll(opacity).toBe('1');
});
