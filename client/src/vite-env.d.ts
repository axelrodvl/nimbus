/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Абсолютный адрес бэкенда для нативных оболочек; пусто — тот же origin. */
  readonly VITE_API_BASE?: string;
  /** `1` — собрать и в продакшен-сборке галерею примитивов `/dev/ui` (e2e-сборка). */
  readonly VITE_UI_GALLERY?: string;
}
