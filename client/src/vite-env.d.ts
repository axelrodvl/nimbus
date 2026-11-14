/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Абсолютный адрес бэкенда для нативных оболочек; пусто — тот же origin. */
  readonly VITE_API_BASE?: string;
  /** `1` — собрать и в продакшен-сборке галерею примитивов `/dev/ui` (e2e-сборка). */
  readonly VITE_UI_GALLERY?: string;
}

/** Версия сборки: `package.json` + короткий git-хэш (`define` в Vite). */
declare const __APP_VERSION__: string;
