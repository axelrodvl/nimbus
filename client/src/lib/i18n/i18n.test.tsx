import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE, LOCALE_KEY, LOCALES, negotiateLocale } from './config';
import { enMessages, loadMessages } from './messages';
import { I18nProvider, useLocale, useT } from './provider';
import { createI18nStore, detectLocale, initI18n } from './store';
import { translate } from './translate';

describe('подбор языка', () => {
  it('сохранённый выбор важнее браузера', () => {
    localStorage.setItem(LOCALE_KEY, 'de');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ru-RU']);
    expect(detectLocale()).toBe('de');
  });

  it('без выбора — по navigator.languages в порядке приоритета', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['xx-XX', 'pt-BR', 'ru']);
    expect(detectLocale()).toBe('pt');
  });

  it('неизвестный сохранённый язык игнорируется; ничего не подошло — en', () => {
    localStorage.setItem(LOCALE_KEY, 'xx');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['xx-XX']);
    expect(detectLocale()).toBe(DEFAULT_LOCALE);
  });

  it('недоступное хранилище: подбор по браузеру', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ja-JP']);
    expect(detectLocale()).toBe('ja');
  });

  it('negotiateLocale понимает q-значения и пустой заголовок', () => {
    expect(negotiateLocale('fr;q=0.5,ru;q=0.9')).toBe('ru');
    expect(negotiateLocale('')).toBe('en');
    expect(negotiateLocale(null)).toBe('en');
    expect(negotiateLocale('ru;q=0')).toBe('en');
  });
});

describe('translate', () => {
  it('подставляет параметры; неизвестный параметр остаётся как есть', () => {
    expect(translate({ k: 'Hi {name}, {x}' }, 'en', 'k', { name: 'Bob' })).toBe('Hi Bob, {x}');
  });

  it('формы множественного числа', () => {
    const m = { n: { one: '{count} track', other: '{count} tracks' } };
    expect(translate(m, 'en', 'n', { count: 1 })).toBe('1 track');
    expect(translate(m, 'en', 'n', { count: 5 })).toBe('5 tracks');
  });

  it('запасной словарь для отсутствующего ключа, иначе сам ключ', () => {
    expect(translate({}, 'ru', 'a', undefined, { a: 'Fallback' })).toBe('Fallback');
    expect(translate({}, 'ru', 'zzz')).toBe('zzz');
  });
});

describe('словари', () => {
  it('во всех языках одинаковый набор ключей', async () => {
    const expected = Object.keys(enMessages).sort();
    for (const { code } of LOCALES) {
      const keys = Object.keys(await loadMessages(code)).sort();
      expect(keys, code).toEqual(expected);
    }
  });
});

function Probe() {
  const t = useT();
  const locale = useLocale();
  return (
    <p>
      {locale}:{t('common.cancel')}
    </p>
  );
}

describe('I18nProvider и хранилище', () => {
  it('до загрузки показывается en, затем ленивый словарь применяется и lang обновляется', async () => {
    const store = createI18nStore();
    render(
      <I18nProvider store={store}>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('en:Cancel')).toBeInTheDocument();
    await act(() => store.setLocale('ru'));
    expect(screen.getByText('ru:Отмена')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('ru');
    expect(localStorage.getItem(LOCALE_KEY)).toBe('ru');
  });

  it('initI18n подгружает определённый язык, не сохраняя его как выбор', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ru-RU']);
    const store = createI18nStore();
    await initI18n(store);
    expect(store.getState().locale).toBe('ru');
    expect(localStorage.getItem(LOCALE_KEY)).toBeNull();
  });

  it('при гонке побеждает последний выбор', async () => {
    const store = createI18nStore();
    const first = store.setLocale('hi');
    const second = store.setLocale('de');
    await Promise.all([first, second]);
    expect(store.getState().locale).toBe('de');
  });

  it('недоступное хранилище не мешает сменить язык', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const store = createI18nStore();
    await store.setLocale('es');
    expect(store.getState().locale).toBe('es');
  });

  it('отписка прекращает уведомления', async () => {
    const store = createI18nStore();
    const l = vi.fn();
    store.subscribe(l)();
    await store.setLocale('fr');
    expect(l).not.toHaveBeenCalled();
  });

  it('useT вне провайдера бросает понятную ошибку', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/I18nProvider/);
  });
});
