// Доступность (шаг 49): axe на каждом экране матрицы (1440, обе темы), клавиатурные сценарии, reduced motion.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resetMock, seedPlayer } from '../e2e/mock';
import { openScreen, SCREENS } from './screens';

const useTheme =
  (theme: 'light' | 'dark') =>
  async ({ context }: { context: BrowserContext }) =>
    context.addInitScript(t => localStorage.setItem('nimbus:theme', t), theme);

/**
 * Исключения axe — только с обоснованием.
 * - `opacity-55`: намеренно приглушённые строки и карточки (трек недоступен без сети / не в библиотеке) — неактивные
 *   элементы освобождены от требований контраста (WCAG 1.4.3); состояние дублируется подсказкой и `aria`-атрибутами.
 * - `palette-scroll`: прокручиваемый список палитры — паттерн combobox: фокус остаётся в поле ввода, активный вариант
 *   (`aria-activedescendant`) прокручивается в видимую область, поэтому список недостижим по Tab намеренно.
 * - `__focus-trap`: служебные «стражи» фокуса диалогов Ariakit (`aria-hidden` + `tabindex`), не контент страницы.
 */
const AXE_EXCLUDE: string[] = ['[class*="opacity-55"]', '[class*="__focus-trap"]', '[data-testid="palette-scroll"]'];

for (const theme of ['dark', 'light'] as const) {
  test.describe(`axe · ${theme}`, () => {
    test.use({ viewport: { height: 900, width: 1440 } });
    test.beforeEach(useTheme(theme));

    for (const screen of SCREENS) {
      test(screen.name, async ({ context, page, request }) => {
        await openScreen(screen, { page, request }, () => context.setOffline(true));
        const results = await AXE_EXCLUDE.reduce(
          (b, selector) => b.exclude(selector),
          new AxeBuilder({ page }),
        ).analyze();
        const bad = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
        expect(
          bad.map(
            v =>
              `${v.id} (${v.impact}): ${v.nodes
                .map(n => n.target.join(' '))
                .slice(0, 4)
                .join(' | ')}`,
          ),
        ).toEqual([]);
      });
    }
  });
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el
      ? `${el.tagName.toLowerCase()}|${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''}`
      : '';
  });

test.describe('клавиатура', () => {
  test.use({ viewport: { height: 900, width: 1440 } });
  test.beforeEach(async ({ request }) => {
    await resetMock(request);
    await seedPlayer(request);
  });

  test('Tab: у каждого сфокусированного элемента виден фокус, порядок не зацикливается внутри шапки', async ({
    page,
  }) => {
    await page.goto('/album/903');
    await expect(page.getByTestId('album-tracks')).toBeVisible();
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const ring = cs.boxShadow !== 'none';
        return {
          id: `${el.tagName}|${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20)}`,
          ok: outline || ring,
        };
      });
      if (!info) continue;
      expect(info.ok, `нет видимого фокуса: ${info.id}`).toBe(true);
      seen.add(info.id);
    }
    // Фокус действительно ходит по разным элементам (а не застревает).
    expect(seen.size).toBeGreaterThan(15);
  });

  test('диалог ловит фокус, Esc закрывает и возвращает фокус на кнопку', async ({ page }) => {
    await page.goto('/album/903');
    await expect(page.getByTestId('album-tracks')).toBeVisible();
    const trigger = page.locator('[data-track-id]').first().getByTestId('track-menu');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const item = page
      .getByRole('menuitem')
      .filter({ hasText: /playlist/i })
      .first();
    await expect(item).toBeVisible();
    // Меню управляется стрелками.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Фокус никогда не попадает на страницу за диалогом: либо внутри, либо (на цикле «последний → первый») на body.
    let outside = 0;
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      const where = await dialog.evaluate(d =>
        d.contains(document.activeElement) ? 'in' : document.activeElement === document.body ? 'body' : 'page',
      );
      expect(where).not.toBe('page');
      outside = where === 'in' ? 0 : outside + 1;
      expect(outside).toBeLessThan(2);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('Esc закрывает верхний слой: палитра над страницей', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await focused(page)).not.toBe('body|');
  });

  test('все действия строки трека доступны с клавиатуры: играть, меню, пункты меню', async ({ page }) => {
    await page.goto('/album/903');
    const row = page.locator('[data-track-id="9031"]');
    await expect(row).toBeVisible();
    await row.getByRole('button').first().focus();
    await expect(row.getByRole('button').first()).toBeFocused();
    await row.getByTestId('track-menu').focus();
    await page.keyboard.press('Enter');
    const items = page.getByRole('menuitem');
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThan(1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Escape');
    await expect(items).toHaveCount(0);
  });
});

test.describe('prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce', viewport: { height: 900, width: 1440 } });

  test('у ключевых элементов нет переходов и анимаций', async ({ page, request }) => {
    await resetMock(request);
    await seedPlayer(request);
    await page.goto('/album/903');
    await page.getByTestId('play-album').first().click();
    await expect(page.getByTestId('player-bar')).toBeVisible();
    const offenders = await page.evaluate(() => {
      const bad: string[] = [];
      const motion = (s: CSSStyleDeclaration) => {
        const dur = (v: string) => v.split(',').some(x => parseFloat(x) > 0.011);
        const anim = s.animationName !== 'none' && dur(s.animationDuration) && s.animationIterationCount !== '0';
        return dur(s.transitionDuration) || anim;
      };
      for (const el of document.querySelectorAll<HTMLElement>('button, a, [data-testid], [role=dialog]')) {
        if (motion(getComputedStyle(el)))
          bad.push(
            `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? ''}]`,
          );
      }
      return [...new Set(bad)].slice(0, 15);
    });
    expect(offenders).toEqual([]);
  });
});
