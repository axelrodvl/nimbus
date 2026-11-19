import { createStore } from 'zustand/vanilla';
import { appData } from '@/lib/app-data';
import { offline } from '@/lib/offline';
import { authHeaders } from '@/lib/platform/auth-transport';
import { currentTrack } from '@/lib/player/engine';
import { player } from '@/lib/player';
import { IMAGE_CACHE } from '@/sw/cache';
import { runWarm, warmTargets, WARM_NAV_QUIET_MS, type WarmProgress } from './warm';

/* v8 ignore start -- браузерная обвязка: Cache API, сеть, плеер; логика — в `warm.ts` (юнит-тесты), прогон — e2e */

/** Состояние прогрева для настроек: сколько миниатюр уже в кэше из тех, что стоит прогреть. */
export const warmStatus = createStore<
  Pick<WarmProgress, 'total' | 'warmed'> & { state: WarmProgress['state'] | 'idle' }
>(() => ({ state: 'idle', total: 0, warmed: 0 }));

let lastNavigation = 0;
/** Пользователь перешёл на другой экран: прогрев молчит ещё `WARM_NAV_QUIET_MS`. */
export const noteNavigation = (): void => void (lastNavigation = Date.now());

const connection = () => (globalThis.navigator as { connection?: { saveData?: boolean } } | undefined)?.connection;

/** Идёт воспроизведение со стрима (скачанный на устройство трек сеть не занимает). */
function streaming(): boolean {
  const s = player().state;
  const id = currentTrack(s)?.id;
  return s.isPlaying && id !== undefined && !offline().playback.has(id);
}

const warmingEnabled = () => offline().settings.getState().warmThumbs;

/**
 * Запускает прогрев миниатюр библиотеки: после загрузки данных и затем на изменения (не чаще раза в 10 с), пока
 * включена настройка. Возвращает остановку.
 */
export function startWarming(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: AbortController | null = null;
  let dirty = false;
  let stopped = false;

  const run = async () => {
    const { library } = appData();
    const state = library.getState();
    if (stopped || !state.hydrated || !warmingEnabled() || typeof caches === 'undefined') return;
    if (running) {
      dirty = true;
      return;
    }
    const ctl = new AbortController();
    running = ctl;
    try {
      const cache = await caches.open(IMAGE_CACHE);
      const urls = warmTargets(state.artists.values(), state.albums.values());
      await runWarm(urls, {
        cache,
        enabled: warmingEnabled,
        fetch: url => fetch(url, { headers: authHeaders() }),
        onProgress: p => warmStatus.setState({ state: p.state, total: p.total, warmed: p.warmed }),
        paused: () =>
          streaming() || Date.now() - lastNavigation < WARM_NAV_QUIET_MS || globalThis.navigator?.onLine === false,
        saveData: () => connection()?.saveData === true,
        signal: ctl.signal,
        sleep: ms => new Promise(r => setTimeout(r, ms)),
      });
    } catch {
      // Кэш недоступен (приватное окно): прогрева нет.
    } finally {
      running = null;
      if (dirty) {
        dirty = false;
        schedule(10_000);
      }
    }
  };

  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), ms);
  };

  const offLibrary = appData().library.subscribe((s, prev) => {
    if (s.hydrated && (!prev.hydrated || s.albums !== prev.albums || s.artists !== prev.artists)) {
      // Первый запуск — не сразу: экран и синхронизация важнее.
      schedule(prev.hydrated ? 10_000 : 3_000);
    }
  });
  // Настройку включили — прогрев начинается; выключили — текущий проход останавливается сам (`enabled`).
  const offSettings = offline().settings.subscribe((s, prev) => {
    if (s.warmThumbs && !prev.warmThumbs) schedule(500);
    if (!s.warmThumbs) warmStatus.setState({ state: 'idle' });
  });
  if (appData().library.getState().hydrated) schedule(3_000);

  return () => {
    stopped = true;
    clearTimeout(timer);
    running?.abort();
    offLibrary();
    offSettings();
  };
}
/* v8 ignore stop */
