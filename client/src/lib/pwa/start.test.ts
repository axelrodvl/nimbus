import { afterEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn() }));
const playing = vi.hoisted(() => ({ value: false }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/lib/player', () => ({ player: () => ({ state: { isPlaying: playing.value } }) }));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  toastMock.mockClear();
  toastMock.success.mockClear();
  playing.value = false;
});

function fakeServiceWorker() {
  let foundListener: () => void = () => undefined;
  const worker = { addEventListener: (_: string, l: () => void) => l(), postMessage: vi.fn(), state: 'installed' };
  const registration = {
    addEventListener: (_: string, l: () => void) => void (foundListener = l),
    installing: worker,
    update: async () => undefined,
    waiting: null,
  };
  const register = vi.fn(async () => registration);
  const container = { addEventListener: vi.fn(), controller: {}, ready: Promise.resolve(), register };
  return { container, found: () => foundListener(), register, worker };
}

describe('startPwa', () => {
  it('в dev SW не регистрируется; повторный вызов ничего не делает', async () => {
    const sw = fakeServiceWorker();
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: sw.container });
    const { startPwa } = await import('./index');
    startPwa();
    startPwa();
    expect(sw.register).not.toHaveBeenCalled();
  });

  async function startInProd(sw: ReturnType<typeof fakeServiceWorker>) {
    vi.stubEnv('PROD', true);
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: sw.container });
    const { startPwa } = await import('./index');
    startPwa();
    await vi.waitFor(() => expect(sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/' }));
    sw.found();
  }

  it('в продакшене регистрирует SW и предлагает обновление toast-ом с кнопкой «Обновить»', async () => {
    const sw = fakeServiceWorker();
    await startInProd(sw);
    expect(toastMock).toHaveBeenCalledTimes(1);
    const [text, options] = toastMock.mock.calls[0]!;
    expect(text).toBe('A new version is available');
    expect(options).toMatchObject({ action: { label: 'Update' }, description: undefined, duration: Infinity });
    options.action.onClick();
    expect(sw.worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('музыка играет — toast предупреждает, что перезагрузка её остановит', async () => {
    playing.value = true;
    await startInProd(fakeServiceWorker());
    expect(toastMock.mock.calls[0]![1].description).toBe('Music will stop when the page reloads.');
  });

  it('после смены версии — одноразовый toast «Обновлено до версии X»', async () => {
    localStorage.setItem('nimbus:pwa:version', '0.0.1');
    await startInProd(fakeServiceWorker());
    expect(toastMock.success).toHaveBeenCalledWith('Updated to version 0.0.0-test');
  });

  it('выход из учётной записи очищает кэш изображений', async () => {
    const del = vi.fn(async () => true);
    vi.stubGlobal('caches', { delete: del });
    vi.stubEnv('PROD', false);
    const { startPwa } = await import('./index');
    const { runLogoutHandlers } = await import('./logout');
    startPwa();
    await runLogoutHandlers();
    expect(del).toHaveBeenCalledWith('nimbus-images-v2');
  });
});
