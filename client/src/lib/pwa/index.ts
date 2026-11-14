import { toast } from 'sonner';
import { clearOffline } from '@/lib/offline';
import { tNow } from '@/lib/i18n/t-now';
import { player } from '@/lib/player';
import { clearImageCache } from './images';
import { listenForInstall } from './install';
import { onLogout } from './logout';
import { createUpdater } from './update';
import { warmDictionaryCache } from './warm';

export { onLogout, runLogoutHandlers } from './logout';

const UPDATE_TOAST = 'pwa-update';

let started = false;

/** Регистрация service worker, проверки обновлений, подсказки установки. Только в продакшен-сборке (в dev SW выключен). */
export function startPwa(i18nReady: Promise<unknown> = Promise.resolve()): void {
  if (started) return;
  started = true;
  onLogout(() => clearImageCache());
  onLogout(() => clearOffline());
  listenForInstall();
  if (!import.meta.env.PROD) return;
  const updater = createUpdater({
    // Сообщение — на языке интерфейса: ждём загрузки словаря (старт приложения раньше неё).
    announceUpdated: version => void i18nReady.then(() => toast.success(tNow('pwa.updated', { version }))),
    container: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
    isPlaying: () => player().state.isPlaying,
    offerUpdate: (apply, playing) =>
      toast(tNow('pwa.updateAvailable'), {
        action: { label: tNow('pwa.update'), onClick: apply },
        description: playing ? tNow('pwa.updateWhilePlaying') : undefined,
        duration: Infinity,
        id: UPDATE_TOAST,
      }),
    onVisible: listener => {
      const handler = () => {
        if (document.visibilityState === 'visible') listener();
      };
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
    reload: () => location.reload(),
    storage: localStorage,
    version: __APP_VERSION__,
  });
  void updater.start();
  // Первая загрузка: словарь текущего языка догружается в кэш после активации воркера.
  if ('serviceWorker' in navigator) void navigator.serviceWorker.ready.then(() => warmDictionaryCache());
}
