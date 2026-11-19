import { describe, expect, it } from 'vitest';
import {
  createOfflineSettings,
  DEFAULT_SETTINGS,
  effectiveLimit,
  MAX_DEFAULT_LIMIT,
  normalizeSettings,
  SETTINGS_KEY,
} from './settings';

const mem = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [[SETTINGS_KEY, initial]]);
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe('настройки офлайна', () => {
  it('по умолчанию: 3 загрузки, лимит автоматический, не только Wi-Fi', () => {
    expect(createOfflineSettings(mem()).getState()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ concurrency: 3, limitBytes: null, warmThumbs: true, wifiOnly: false });
  });

  it('читаются из localStorage; повреждённое значение — настройки по умолчанию', () => {
    expect(createOfflineSettings(mem('{"concurrency":5,"limitBytes":100,"wifiOnly":true}')).getState()).toEqual({
      concurrency: 5,
      limitBytes: 100,
      warmThumbs: true,
      wifiOnly: true,
    });
    expect(createOfflineSettings(mem('{oops')).getState()).toEqual(DEFAULT_SETTINGS);
    expect(createOfflineSettings(null).getState()).toEqual(DEFAULT_SETTINGS);
  });

  it('normalizeSettings ограничивает параллелизм 1…6 и отбрасывает мусор', () => {
    expect(normalizeSettings({ concurrency: 99 }).concurrency).toBe(6);
    expect(normalizeSettings({ concurrency: 0 }).concurrency).toBe(1);
    expect(normalizeSettings({ concurrency: 2.6 }).concurrency).toBe(3);
    expect(normalizeSettings({ concurrency: 'x', limitBytes: -5, wifiOnly: 'yes' })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('прогрев миниатюр включён, пока его явно не выключили', () => {
    expect(normalizeSettings({}).warmThumbs).toBe(true);
    expect(normalizeSettings({ warmThumbs: false }).warmThumbs).toBe(false);
    expect(normalizeSettings({ warmThumbs: 'no' }).warmThumbs).toBe(true);
  });

  it('update сохраняет значение и уведомляет подписчиков', () => {
    const storage = mem();
    const store = createOfflineSettings(storage);
    const seen: number[] = [];
    store.subscribe(s => seen.push(s.concurrency));
    store.update({ concurrency: 4 });
    expect(seen).toEqual([4]);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY)!)).toMatchObject({ concurrency: 4 });
    expect(createOfflineSettings(storage).getState().concurrency).toBe(4);
  });

  it('недоступное хранилище не мешает обновлению', () => {
    const store = createOfflineSettings({
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    });
    expect(() => store.update({ wifiOnly: true })).not.toThrow();
    expect(store.getState().wifiOnly).toBe(true);
  });

  it('лимит по умолчанию — половина квоты, но не более 20 ГБ; квота неизвестна — 20 ГБ; явный лимит главнее', () => {
    expect(effectiveLimit(DEFAULT_SETTINGS, 10_000)).toBe(5000);
    expect(effectiveLimit(DEFAULT_SETTINGS, 100 * 2 ** 30)).toBe(MAX_DEFAULT_LIMIT);
    expect(effectiveLimit(DEFAULT_SETTINGS, null)).toBe(MAX_DEFAULT_LIMIT);
    expect(effectiveLimit({ ...DEFAULT_SETTINGS, limitBytes: 42 }, 10_000)).toBe(42);
  });
});
