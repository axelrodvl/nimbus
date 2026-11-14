import type { AudioSource } from '@/lib/player/audio/types';

/**
 * Где лежат файлы офлайн-треков и как получить источник для плеера. В PWA — OPFS (`opfs-storage.ts`),
 * в нативных оболочках (шаг 54) — файловая система приложения. `trackId` — строка id трека библиотеки.
 */
export interface OfflineStorage {
  isSupported(): boolean;
  list(): Promise<string[]>;
  /** Размер файла в байтах; `null` — файла нет. */
  size(trackId: string): Promise<number | null>;
  remove(trackId: string): Promise<void>;
  usage(): Promise<{ bytes: number; quota: number | null }>;
  /** Источник для плеера (шаг 41); `mime` — из записи о файле. */
  source(trackId: string, mime: string): Promise<AudioSource>;
  /** Освободить источник (web — `revokeObjectURL`). */
  release(trackId: string): void;
}

export type DownloadStart = {
  trackId: string;
  url: string;
  headers: Record<string, string>;
  /** С какого байта докачивать (0 — с начала). */
  offset: number;
  etag: string | null;
};

/** Общие сведения о ходе скачивания: менеджер хранит их, чтобы докачать после обрыва. */
export type DownloadInfo = { bytesDone: number; bytesTotal: number | null; mime: string; etag: string | null; resumable: boolean };

export type DownloadMessage =
  | ({ type: 'progress'; trackId: string } & DownloadInfo)
  | { type: 'done'; trackId: string; bytes: number; mime: string; etag: string | null; resumable: boolean }
  | { type: 'error'; trackId: string; code: DownloadErrorCode; retryable: boolean; bytesDone: number; info?: DownloadInfo }
  /** Воркер освободил файл после отмены (внутренний сигнал `worker-downloader`; менеджер его не получает). */
  | { type: 'aborted'; trackId: string };

export type DownloadErrorCode =
  | 'network'
  | 'timeout'
  | 'http_status'
  | 'unauthorized'
  | 'not_found'
  | 'quota'
  | 'incomplete'
  | 'aborted'
  | 'storage';

/** Кто скачивает файл: в PWA — Web Worker, в нативных оболочках — фоновые загрузки ОС. */
export interface Downloader {
  start(p: DownloadStart): void;
  /** Прерывает загрузку; промис завершается, когда файл освобождён (его можно удалять). Отмена ничего не сообщает через `on`. */
  abort(trackId: string): void | Promise<void>;
  on(handler: (m: DownloadMessage) => void): () => void;
  /** Продолжает ли качать, когда приложение в фоне или закрыто. */
  readonly background: boolean;
}

/** Сообщения воркера скачивания (формат — `download.worker.ts`). */
export type WorkerRequest = ({ type: 'start' } & DownloadStart) | { type: 'abort'; trackId: string };

export type OfflineSettings = {
  /** Лимит места под офлайн-треки, байт; `null` — по умолчанию (50 % квоты, но не более 20 ГБ). */
  limitBytes: number | null;
  /** Одновременных загрузок (1…6). */
  concurrency: number;
  /** Качать только по Wi-Fi (где доступен `navigator.connection`). */
  wifiOnly: boolean;
};
