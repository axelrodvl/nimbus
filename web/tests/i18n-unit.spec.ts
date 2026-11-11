// Модульные тесты i18n (без браузера): словари, подстановки, множественное число, выбор языка.
import { expect, test } from '@playwright/test';
import { LOCALES, isLocale, negotiateLocale } from '../lib/i18n/config';
import { en } from '../lib/i18n/messages/en';
import { translate, type Message } from '../lib/i18n/translate';

const placeholders = (m: Message) =>
  [...new Set((typeof m === 'string' ? m : Object.values(m).join(' ')).match(/\{\w+\}/g) ?? [])].sort();

// Загрузчик Playwright оборачивает default-экспорт ещё раз, поэтому разворачиваем до словаря.
const load = async (code: string): Promise<Record<string, Message>> => {
  if (code === 'en') return en as Record<string, Message>;
  const mod = (await import(`../lib/i18n/messages/${code}`)) as { default: unknown };
  const inner = mod.default as { default?: unknown };
  return (inner.default ?? inner) as Record<string, Message>;
};

test('подбор языка по Accept-Language', () => {
  expect(negotiateLocale('ru-RU,ru;q=0.9,en;q=0.8')).toBe('ru');
  expect(negotiateLocale('fr-CH, fr;q=0.9, en;q=0.8')).toBe('fr');
  expect(negotiateLocale('zh-CN,zh;q=0.9')).toBe('zh');
  expect(negotiateLocale('xx, de;q=0.5, es;q=0.7')).toBe('es');
  expect(negotiateLocale('xx-YY')).toBe('en');
  expect(negotiateLocale(null)).toBe('en');
  expect(isLocale('ja') && !isLocale('xx')).toBe(true);
});

test('подстановки и множественное число', () => {
  const m = {
    n: { few: '{count} трека', many: '{count} треков', one: '{count} трек', other: '{count} трека' },
    s: 'Привет, {name}! {missing}',
  };
  expect(translate(m, 'ru', 's', { name: 'Вадим' })).toBe('Привет, Вадим! {missing}');
  expect([1, 2, 5, 11, 21, 22].map(count => translate(m, 'ru', 'n', { count }))).toEqual([
    '1 трек',
    '2 трека',
    '5 треков',
    '11 треков',
    '21 трек',
    '22 трека',
  ]);
  expect(translate({}, 'en', 'no.such.key')).toBe('no.such.key');
});

test('все словари полны: те же ключи, плейсхолдеры и формы множественного числа', async () => {
  for (const { code } of LOCALES) {
    const messages = await load(code);
    expect(Object.keys(messages).sort(), code).toEqual(Object.keys(en).sort());
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories.filter(c => c !== 'other');
    for (const [key, source] of Object.entries(en) as [string, Message][]) {
      const value = messages[key];
      expect(placeholders(value), `${code}: ${key}`).toEqual(placeholders(source));
      expect(value, `${code}: ${key} is empty`).not.toBe('');
      if (typeof source !== 'string') {
        expect(typeof value, `${code}: ${key} must be plural`).toBe('object');
        // Формы, которые нужны языку по CLDR (кроме `many` у языков, где оно только для дробей).
        for (const c of categories) {
          if (c === 'many' && ['es', 'fr', 'it', 'pt'].includes(code)) continue;
          expect(Object.keys(value as object), `${code}: ${key}`).toContain(c);
        }
      }
    }
  }
});
