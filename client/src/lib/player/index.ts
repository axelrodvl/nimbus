import { loadPrefetchEnabled } from '@/lib/api/settings';
import { prefetchTrack } from '@/lib/api/tracks';
import { appData } from '@/lib/app-data';
import { offline } from '@/lib/offline';
import { createAudioEngine } from './audio';
import { PlayerController, type PlayerDeps } from './controller';
import { probeStreamError, STORAGE_KEY } from './engine';
import { notifyPlayerError } from './notify';
import { resolveStreamUrl } from './stream';
import { toPlayerTrack } from './track';

export { canPlay, toPlayerTrack, type PlayerTrack } from './track';
export { PlayerController } from './controller';

/** Зависимости контроллера приложения: библиотека — из синглтона `appData()` (переживает его пересоздание). */
export function appPlayerDeps(over: Partial<PlayerDeps> = {}): PlayerDeps {
  // Настройка читается при первом обращении (не при создании контроллера); пока не загрузилась — включена.
  let prefetch: boolean | null = null;
  return {
    engine: createAudioEngine(),
    getTrack: id => {
      const { library, selectors } = appData();
      const view = selectors.trackView(library.getState(), id);
      return view && toPlayerTrack(view);
    },
    isOffline: id => offline().playback.has(id),
    libraryReady: () => appData().library.getState().tracksHydrated,
    notifyError: notifyPlayerError,
    offlineBroken: id => offline().playback.broken(id),
    prepareOffline: id => offline().playback.prepare(id),
    prefetchEnabled: () => {
      if (prefetch === null) {
        prefetch = true;
        void loadPrefetchEnabled().then(v => (prefetch = v));
      }
      return prefetch;
    },
    prefetchTrack,
    probe: src => probeStreamError(src.url, fetch, src.headers),
    recordPlay: id => appData().mutations.recordPlay(id),
    resolveStreamUrl,
    storage: globalThis.localStorage,
    // Статусы треков, скачанные файлы и связь влияют на то, что можно играть и что считать «следующим».
    subscribeLibrary: listener => {
      let revision = offline().status.getState().doneRevision;
      const offs = [
        appData().library.subscribe(listener),
        // Прогресс скачивания не интересен — только смена набора треков, доступных без сети.
        offline().status.subscribe(s => {
          if (s.doneRevision !== revision) {
            revision = s.doneRevision;
            listener();
          }
        }),
      ];
      return () => offs.forEach(off => off());
    },
    ...over,
  };
}

let instance: PlayerController | null = null;

/** Контроллер плеера приложения (создаётся при первом обращении; один на всю жизнь вкладки). */
export function player(): PlayerController {
  instance ??= new PlayerController(appPlayerDeps());
  return instance;
}

/**
 * Останавливает звук и забывает контроллер (выход из аккаунта): следующий `player()` начнёт заново.
 * `clear` стирает ещё и сохранённую очередь.
 */
export function resetPlayer(clear = false): void {
  instance?.destroy();
  instance = null;
  if (clear) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Хранилище недоступно.
    }
  }
}

/** Подмена контроллера приложения (тесты компонентов: контроллер с фейковым движком). */
export function installPlayer(controller: PlayerController): void {
  instance?.destroy();
  instance = controller;
}
