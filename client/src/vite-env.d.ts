/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Абсолютный адрес бэкенда для нативных оболочек; пусто — тот же origin. */
  readonly VITE_API_BASE?: string;
}
