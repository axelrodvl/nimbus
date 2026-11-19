import { beforeEach, describe, expect, it } from 'vitest';
import { imageLoading, markImageShown, primeShownFromCache, resetShownImages } from './cover';

const keys =
  (...urls: string[]) =>
  async () => ({ keys: async () => urls.map(u => new Request(u)) });

beforeEach(resetShownImages);

describe('primeShownFromCache', () => {
  it('адреса из кэша после «перезапуска» идут eager/sync, прочие — lazy/async', async () => {
    const url = '/api/covers/release-group/abc/250';
    expect(imageLoading(url)).toEqual({ decoding: 'async', loading: 'lazy' });
    const n = await primeShownFromCache(
      keys('https://nimbus.test/api/covers/release-group/abc/250', 'https://other.test/x.jpg'),
      'https://nimbus.test',
    );
    expect(n).toBe(2);
    expect(imageLoading(url)).toEqual({ decoding: 'sync', loading: 'eager' });
    // Чужой origin — адрес целиком.
    expect(imageLoading('https://other.test/x.jpg').loading).toBe('eager');
    expect(imageLoading('/api/covers/release-group/zzz/250').loading).toBe('lazy');
  });

  it('кэш недоступен или слишком велик («Operation too large»): остаётся прежнее поведение', async () => {
    const broken = async () => ({
      keys: async () => {
        throw new Error('Operation too large');
      },
    });
    expect(await primeShownFromCache(broken, 'https://nimbus.test')).toBe(0);
    expect(await primeShownFromCache(async () => Promise.reject(new Error('no caches')), '')).toBe(0);
    expect(imageLoading('/x').loading).toBe('lazy');
  });

  it('ключи с запросом сохраняют запрос, а показанные в сессии по-прежнему помнятся', async () => {
    await primeShownFromCache(keys('https://nimbus.test/api/covers/a/b/250?v=1'), 'https://nimbus.test');
    expect(imageLoading('/api/covers/a/b/250?v=1').loading).toBe('eager');
    markImageShown('/y');
    expect(imageLoading('/y').loading).toBe('eager');
  });
});
