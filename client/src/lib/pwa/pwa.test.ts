import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearImageCache } from './images';
import {
  listenForInstall,
  needsIosInstallHint,
  promptInstall,
  resetInstallForTests,
  type InstallPromptEvent,
} from './install';
import { onLogout, runLogoutHandlers } from './logout';
import { warmDictionaryCache } from './warm';
import { PERSIST_KEY, readStorageInfo, requestPersistentStorage, requestPersistNow } from './storage';
import {
  CHECK_INTERVAL_MS,
  createUpdater,
  VERSION_KEY,
  type SwContainer,
  type SwRegistration,
  type SwWorker,
} from './update';

function fakeWorker(state = 'installed'): SwWorker & { fire(): void; posted: unknown[] } {
  let listener: (() => void) | undefined;
  return {
    addEventListener: (_t, l) => void (listener = l),
    fire: () => listener?.(),
    posted: [],
    postMessage(m) {
      this.posted.push(m);
    },
    state,
  };
}

function fakeSw(opts: { controller?: boolean; waiting?: SwWorker | null } = {}) {
  let found: (() => void) | undefined;
  let changed: (() => void) | undefined;
  const registration: SwRegistration & { updates: number } = {
    addEventListener: (_t, l) => void (found = l),
    installing: null,
    update: async function () {
      registration.updates++;
    },
    updates: 0,
    waiting: opts.waiting ?? null,
  };
  const container: SwContainer = {
    addEventListener: (_t, l) => void (changed = l),
    controller: opts.controller === false ? null : {},
    register: vi.fn(async () => registration),
  };
  return {
    changeController: () => changed?.(),
    container,
    discover(worker: SwWorker) {
      registration.installing = worker;
      found?.();
    },
    registration,
  };
}

function setup(sw: ReturnType<typeof fakeSw> | null, over: { playing?: boolean; version?: string } = {}) {
  const deps = {
    announceUpdated: vi.fn(),
    container: sw?.container ?? null,
    isPlaying: () => over.playing ?? false,
    offerUpdate: vi.fn<(apply: () => void, playing: boolean) => void>(),
    reload: vi.fn(),
    storage: localStorage,
    version: over.version ?? '1.0.0',
  };
  return { deps, updater: createUpdater({ ...deps, onVisible: undefined }) };
}

describe('update.ts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('найдена новая версия → предложение; «Обновить» → SKIP_WAITING, затем перезагрузка', async () => {
    const sw = fakeSw();
    const { deps, updater } = setup(sw);
    await updater.start();
    const worker = fakeWorker();
    sw.discover(worker);
    worker.fire();
    expect(deps.offerUpdate).toHaveBeenCalledTimes(1);
    expect(deps.reload).not.toHaveBeenCalled();
    deps.offerUpdate.mock.calls[0]![0]();
    expect(worker.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(deps.reload).not.toHaveBeenCalled();
    sw.changeController();
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('новая версия уже ждёт при старте → предложение сразу', async () => {
    const sw = fakeSw({ waiting: fakeWorker() });
    const { deps, updater } = setup(sw);
    await updater.start();
    expect(deps.offerUpdate).toHaveBeenCalledTimes(1);
  });

  it('первая установка (контроллера нет) — не обновление', async () => {
    const sw = fakeSw({ controller: false });
    const { deps, updater } = setup(sw);
    await updater.start();
    const worker = fakeWorker();
    sw.discover(worker);
    worker.fire();
    expect(deps.offerUpdate).not.toHaveBeenCalled();
  });

  it('воркер ещё устанавливается — предложения нет до `installed`', async () => {
    const sw = fakeSw();
    const { deps, updater } = setup(sw);
    await updater.start();
    const worker = fakeWorker('installing');
    sw.discover(worker);
    worker.fire();
    expect(deps.offerUpdate).not.toHaveBeenCalled();
  });

  it('во время воспроизведения: предложение помечено, автоперезагрузки нет — ни по таймеру, ни по чужому controllerchange', async () => {
    const sw = fakeSw();
    const { deps, updater } = setup(sw, { playing: true });
    await updater.start();
    const worker = fakeWorker();
    sw.discover(worker);
    worker.fire();
    expect(deps.offerUpdate.mock.calls[0]![1]).toBe(true);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    sw.changeController(); // другая вкладка применила обновление
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('повторные statechange не дублируют предложение', async () => {
    const sw = fakeSw();
    const { deps, updater } = setup(sw);
    await updater.start();
    const worker = fakeWorker();
    sw.discover(worker);
    worker.fire();
    worker.fire();
    expect(deps.offerUpdate).toHaveBeenCalledTimes(1);
  });

  it('проверки: при старте и раз в час; stop останавливает', async () => {
    const sw = fakeSw();
    const { updater } = setup(sw);
    await updater.start();
    expect(sw.registration.updates).toBe(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(sw.registration.updates).toBe(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(sw.registration.updates).toBe(4);
    updater.stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(sw.registration.updates).toBe(4);
  });

  it('возврат вкладки на передний план запускает проверку; сбой проверки проглатывается', async () => {
    const sw = fakeSw();
    let visible: () => void = () => undefined;
    const stop = vi.fn();
    const updater = createUpdater({
      announceUpdated: vi.fn(),
      container: sw.container,
      isPlaying: () => false,
      offerUpdate: vi.fn(),
      onVisible: l => {
        visible = l;
        return stop;
      },
      reload: vi.fn(),
      version: '1',
    });
    await updater.start();
    sw.registration.update = () => Promise.reject(new TypeError('offline'));
    visible();
    await vi.advanceTimersByTimeAsync(0);
    updater.stop();
    expect(stop).toHaveBeenCalled();
  });

  it('регистрация не удалась или SW не поддерживается — тихо', async () => {
    const { updater } = setup(null);
    await expect(updater.start()).resolves.toBeUndefined();
    const sw = fakeSw();
    sw.container.register = () => Promise.reject(new Error('blocked'));
    const second = setup(sw);
    await expect(second.updater.start()).resolves.toBeUndefined();
    second.updater.apply(); // без ожидающего воркера — ничего не делает
  });

  it('одноразовое «Обновлено до версии X»', async () => {
    localStorage.setItem(VERSION_KEY, '1.0.0');
    const first = setup(null, { version: '1.1.0' });
    await first.updater.start();
    expect(first.deps.announceUpdated).toHaveBeenCalledWith('1.1.0');
    const again = setup(null, { version: '1.1.0' });
    await again.updater.start();
    expect(again.deps.announceUpdated).not.toHaveBeenCalled();
  });

  it('первый запуск — версия запоминается без сообщения', async () => {
    const { deps, updater } = setup(null, { version: '1.0.0' });
    await updater.start();
    expect(deps.announceUpdated).not.toHaveBeenCalled();
    expect(localStorage.getItem(VERSION_KEY)).toBe('1.0.0');
  });

  it('недоступный localStorage не ломает запуск', async () => {
    const storage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    const updater = createUpdater({
      announceUpdated: vi.fn(),
      container: null,
      isPlaying: () => false,
      offerUpdate: vi.fn(),
      reload: vi.fn(),
      storage,
      version: '1',
    });
    await expect(updater.start()).resolves.toBeUndefined();
  });
});

describe('storage.ts', () => {
  it('persist вызывается один раз', async () => {
    const manager = { persist: vi.fn(async () => true) };
    expect(await requestPersistentStorage(manager, localStorage)).toBe(true);
    expect(await requestPersistentStorage(manager, localStorage)).toBe(false);
    expect(manager.persist).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PERSIST_KEY)).toBe('1');
  });

  it('нет API, отказ браузера и сломанный localStorage — без ошибок', async () => {
    expect(await requestPersistentStorage({}, localStorage)).toBe(false);
    expect(await requestPersistentStorage(undefined, localStorage)).toBe(false);
    const reject = { persist: vi.fn(() => Promise.reject(new Error('no'))) };
    expect(await requestPersistentStorage(reject, null)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    expect(await requestPersistentStorage({ persist: async () => true }, broken)).toBe(true);
  });

  it('requestPersistNow: результат браузера; без API и при отказе — false', async () => {
    expect(await requestPersistNow({ persist: async () => true })).toBe(true);
    expect(await requestPersistNow({ persist: async () => false })).toBe(false);
    expect(await requestPersistNow({})).toBe(false);
    expect(await requestPersistNow(undefined)).toBe(false);
    expect(await requestPersistNow({ persist: () => Promise.reject(new Error('no')) })).toBe(false);
  });

  it('readStorageInfo: размер, квота, признак постоянства; без API — пусто', async () => {
    expect(
      await readStorageInfo({ estimate: async () => ({ quota: 100, usage: 40 }), persisted: async () => true }),
    ).toEqual({ persistent: true, quota: 100, usage: 40 });
    expect(await readStorageInfo(undefined)).toEqual({ persistent: false, quota: null, usage: null });
    expect(
      await readStorageInfo({
        estimate: () => Promise.reject(new Error('x')),
      }),
    ).toEqual({ persistent: false, quota: null, usage: null });
  });
});

describe('logout.ts и images.ts', () => {
  it('обработчики выхода вызываются, сбой одного не мешает остальным; отписка работает', async () => {
    const a = vi.fn();
    const b = vi.fn(() => Promise.reject(new Error('boom')));
    const c = vi.fn();
    const offs = [onLogout(a), onLogout(b), onLogout(c)];
    await runLogoutHandlers();
    expect([a, b, c].map(f => f.mock.calls.length)).toEqual([1, 1, 1]);
    offs[0]!();
    await runLogoutHandlers();
    expect(a).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(2);
    offs.forEach(off => off());
  });

  it('clearImageCache удаляет кэш изображений; сбой и отсутствие Cache API проглатываются', async () => {
    const del = vi.fn(async () => true);
    await clearImageCache({ delete: del });
    expect(del).toHaveBeenCalledWith('nimbus-images-v2');
    await expect(clearImageCache({ delete: () => Promise.reject(new Error('x')) })).resolves.toBeUndefined();
    await expect(clearImageCache(undefined)).resolves.toBeUndefined();
  });
});

describe('install.ts', () => {
  afterEach(resetInstallForTests);

  function installEvent(outcome: 'accepted' | 'dismissed') {
    const e = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
    e.prompt = vi.fn(async () => undefined);
    e.userChoice = Promise.resolve({ outcome });
    return e;
  }

  it('beforeinstallprompt перехватывается; promptInstall одноразовый; appinstalled сбрасывает', async () => {
    const target = new EventTarget();
    listenForInstall(target as unknown as Window);
    expect(await promptInstall()).toBe('unavailable');
    const e = installEvent('accepted');
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(await promptInstall()).toBe('accepted');
    expect(e.prompt).toHaveBeenCalled();
    expect(await promptInstall()).toBe('unavailable');
    target.dispatchEvent(installEvent('dismissed'));
    target.dispatchEvent(new Event('appinstalled'));
    expect(await promptInstall()).toBe('unavailable');
  });

  it('подсказка iOS: только Safari на iPhone/iPad вне standalone', () => {
    const safari =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
    expect(needsIosInstallHint({ userAgent: safari }, false)).toBe(true);
    expect(needsIosInstallHint({ userAgent: safari }, true)).toBe(false);
    expect(needsIosInstallHint({ standalone: true, userAgent: safari }, false)).toBe(false);
    expect(needsIosInstallHint({ userAgent: `${safari} CriOS/120` }, false)).toBe(false);
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
    expect(needsIosInstallHint({ maxTouchPoints: 5, userAgent: ipad }, false)).toBe(true);
    expect(needsIosInstallHint({ maxTouchPoints: 0, userAgent: ipad }, false)).toBe(false);
    expect(needsIosInstallHint({ userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/120 Safari/537' }, false)).toBe(false);
  });
});

describe('warm.ts', () => {
  const entry = (name: string) => ({ name });
  it('дописывает в кэш загруженные словари своего origin; прочие ресурсы не трогает', async () => {
    const add = vi.fn(async () => undefined);
    const caches = { open: vi.fn(async () => ({ add })) };
    const perf = {
      getEntriesByType: () => [
        entry('https://n.test/assets/ru-AbC.js'),
        entry('https://n.test/assets/index-X.js'),
        entry('https://cdn.test/assets/de-AbC.js'),
        entry('garbage'),
      ],
    };
    expect(await warmDictionaryCache(perf, caches, 'https://n.test')).toBe(1);
    expect(caches.open).toHaveBeenCalledWith('nimbus-runtime-v1');
    expect(add).toHaveBeenCalledWith('https://n.test/assets/ru-AbC.js');
  });

  it('нет словарей, нет API или сбой кэша — 0 без ошибок', async () => {
    const none = { getEntriesByType: () => [] };
    expect(
      await warmDictionaryCache(none, { open: async () => ({ add: async () => undefined }) }, 'https://n.test'),
    ).toBe(0);
    expect(await warmDictionaryCache(undefined, undefined)).toBe(0);
    const perf = { getEntriesByType: () => [entry('https://n.test/assets/ru-AbC.js')] };
    const broken = { open: () => Promise.reject(new Error('quota')) };
    expect(await warmDictionaryCache(perf, broken, 'https://n.test')).toBe(0);
  });
});
