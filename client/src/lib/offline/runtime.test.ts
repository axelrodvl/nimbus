import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAppData } from '@/lib/app-data';
import { FakeDownloader, FakeTabs, MemoryStorage } from '@/test/offline';
import { seed } from '@/test/seed';
import { clearOffline, createOfflineRuntime, installOffline, offline, startOffline, stopOffline } from './index';

afterEach(async () => {
  installOffline(null);
  await resetAppData(true);
});

const net = { cellular: () => false, online: () => true, subscribe: () => () => undefined };

describe('офлайн-окружение приложения', () => {
  it('без хранилища (нет OPFS): supported = false, менеджер не стартует, плеер работает как раньше', async () => {
    const rt = createOfflineRuntime(null);
    installOffline(rt);
    expect(rt.status.getState().supported).toBe(false);
    expect(rt.playback.has(1)).toBe(false);
    expect(rt.playback.resolve(1)).toBeNull();
    expect(() => {
      rt.playback.prepare(1);
      rt.playback.broken(1);
    }).not.toThrow();
    expect(await startOffline()).toBeNull();
    await clearOffline(); // нечего очищать
    stopOffline();
  });

  it('в окружении без OPFS (happy-dom) по умолчанию офлайн отключён', () => {
    expect(offline().status.getState().supported).toBe(false);
  });

  it('startOffline: поднимает менеджер на данных приложения; повторный вызов возвращает его же', async () => {
    seed({});
    const storage = new MemoryStorage();
    const rt = createOfflineRuntime(storage);
    installOffline(rt);
    const downloader = new FakeDownloader();
    const first = await startOffline({ downloader, network: net, tabs: new FakeTabs() });
    expect(first).not.toBeNull();
    expect(rt.manager).toBe(first);
    expect(await startOffline({ downloader })).toBe(first);
    expect(rt.status.getState().supported).toBe(true);
    stopOffline();
    expect(rt.manager).toBeNull();
  });

  it('clearOffline без запущенного менеджера удаляет файлы и записи', async () => {
    const storage = new MemoryStorage();
    storage.files.set('1', 5);
    const rt = createOfflineRuntime(storage);
    installOffline(rt);
    await clearOffline();
    expect(storage.files.size).toBe(0);
    expect(rt.status.getState().files.size).toBe(0);
  });

  it('clearOffline с запущенным менеджером: закрепления, файлы и записи стираются', async () => {
    seed({});
    const storage = new MemoryStorage();
    const rt = createOfflineRuntime(storage);
    installOffline(rt);
    const m = await startOffline({ downloader: new FakeDownloader(), network: net, tabs: new FakeTabs() });
    await m!.pin('track', 1);
    await clearOffline();
    expect(rt.manager).toBeNull();
    expect(rt.status.getState().pins.size).toBe(0);
  });

  it('playback.broken без менеджера не падает', () => {
    const rt = createOfflineRuntime(new MemoryStorage());
    const spy = vi.fn();
    rt.playback.broken(1);
    expect(spy).not.toHaveBeenCalled();
  });
});
