// Контраст токенов текста (шаг 49): ≥ 4.5:1 на поверхностях обеих тем. Токен нельзя «чинить» в одном месте и ломать в другом.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');
const themeBlock = css.slice(css.indexOf('@theme'), css.indexOf('@custom-variant'));
const darkBlock = css.slice(css.indexOf('.dark {'));

const tokens = (block: string) =>
  Object.fromEntries(
    [...block.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1] as string, m[2] as string]),
  );
const light = tokens(themeBlock);
const dark = { ...light, ...tokens(darkBlock) };

const channel = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => channel(parseInt(hex.slice(i, i + 2), 16))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** Цвет `fg` с прозрачностью `alpha` поверх `bg` (плашки с прозрачностью 15 %). */
const over = (fg: string, bg: string, alpha: number) =>
  '#' +
  [1, 3, 5]
    .map(i =>
      Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

const TEXT = ['muted', 'gray', 'accent-fg', 'danger-fg', 'success-fg', 'warning-fg'];

describe('контраст токенов', () => {
  it.each([
    ['светлая', light, ['surface', 'card']],
    ['тёмная', dark, ['surface-dark', 'card-dark']],
  ] as const)('текстовые цвета на поверхностях: %s тема ≥ 4.5:1', (_name, theme, surfaces) => {
    for (const text of TEXT) {
      for (const surface of surfaces)
        expect(ratio(theme[text]!, theme[surface]!), `${text} на ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ['светлая', light, 'surface'],
    ['тёмная', dark, 'surface-dark'],
  ] as const)('цветной текст на плашках с фоном 15 %: %s тема', (_name, theme, surface) => {
    for (const tone of ['accent', 'danger', 'success', 'warning']) {
      const fg = theme[`${tone}-fg`]!;
      expect(ratio(fg, over(fg, theme[surface]!, 0.15)), `${tone}-fg на плашке`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('белый текст на заливках (кнопки, значки) ≥ 4.5:1 в обеих темах', () => {
    for (const theme of [light, dark]) {
      for (const fill of ['accent', 'accent-hover', 'danger'])
        expect(ratio('#ffffff', theme[fill]!), fill).toBeGreaterThanOrEqual(4.5);
    }
  });
});
