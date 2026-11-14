import { DEFAULT_LOCALE, isLocale, LOCALE_KEY, negotiateLocale, type Locale } from './config';
import { enMessages, loadMessages, type Messages } from './messages';

export type I18nState = { locale: Locale; messages: Messages };

/** Язык при старте: сохранённый выбор → `navigator.languages` → `en`. */
export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // Хранилище недоступно — подбираем по браузеру.
  }
  // Без q-значений приоритет — порядок в списке (сортировка стабильна).
  return negotiateLocale(globalThis.navigator?.languages?.join(','));
}

/**
 * Хранилище языка. Пока словарь выбранного языка не загружен, показывается `en`
 * (`locale` меняется вместе со словарём, чтобы правила множественного числа не расходились с текстом).
 */
export function createI18nStore(initial?: I18nState) {
  let state: I18nState = initial ?? { locale: DEFAULT_LOCALE, messages: enMessages };
  const listeners = new Set<() => void>();
  let seq = 0;

  const apply = (next: I18nState) => {
    state = next;
    document.documentElement.lang = next.locale;
    listeners.forEach(l => l());
  };

  return {
    getState: () => state,
    /** Загружает словарь и переключает язык; `persist` — запомнить выбор. Параллельные вызовы: побеждает последний. */
    async setLocale(locale: Locale, persist = true): Promise<void> {
      const mine = ++seq;
      if (persist) {
        try {
          localStorage.setItem(LOCALE_KEY, locale);
        } catch {
          // Не удалось запомнить — язык действует до перезагрузки.
        }
      }
      const messages = await loadMessages(locale);
      if (mine === seq) apply({ locale, messages });
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type I18nStore = ReturnType<typeof createI18nStore>;

/** Хранилище приложения. */
export const i18n = createI18nStore();

/** Определяет язык и подгружает его словарь (вызывается один раз при старте). */
export function initI18n(store: I18nStore = i18n): Promise<void> {
  return store.setLocale(detectLocale(), false);
}

export const setLocale = (locale: Locale): Promise<void> => i18n.setLocale(locale);
