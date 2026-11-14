import type { AudioSource } from '@/lib/player/audio/types';
import type { OfflineStorage } from './types';

/** Каталог OPFS, где лежат файлы треков (`tracks/<trackId>`, без расширения). */
export const TRACKS_DIR = 'tracks';

/** Часть `FileSystemDirectoryHandle`, которая нужна модулю (в тестах — фейк). */
export type DirLike = {
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirLike>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<{ getFile(): Promise<File> }>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
};

export type OpfsDeps = {
  /** Корень OPFS (`navigator.storage.getDirectory()`). */
  getRoot(): Promise<DirLike>;
  supported(): boolean;
  estimate(): Promise<{ usage?: number; quota?: number }>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
};

const isNotFound = (e: unknown) => (e as { name?: string } | null)?.name === 'NotFoundError';

/**
 * OPFS: файлы пишет воркер (`createSyncAccessHandle`), здесь — чтение, размер, удаление и источник для плеера:
 * `URL.createObjectURL(Blob)` ссылается на файл на диске, не читая его в память, и поддерживает перемотку.
 * Единственное место (вместе с воркером), где разрешён доступ к OPFS и `navigator.storage`.
 */
export function createOpfsStorage(deps: OpfsDeps): OfflineStorage {
  const urls = new Map<string, string>();
  let dirPromise: Promise<DirLike> | null = null;
  const dir = () => (dirPromise ??= deps.getRoot().then(root => root.getDirectoryHandle(TRACKS_DIR, { create: true })));

  return {
    isSupported: () => deps.supported(),
    async list() {
      const out: string[] = [];
      for await (const name of (await dir()).keys()) out.push(name);
      return out;
    },
    release(trackId) {
      const url = urls.get(trackId);
      if (url === undefined) return;
      urls.delete(trackId);
      deps.revokeObjectURL(url);
    },
    async remove(trackId) {
      this.release(trackId);
      try {
        await (await dir()).removeEntry(trackId);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
    async size(trackId) {
      try {
        return (await (await (await dir()).getFileHandle(trackId)).getFile()).size;
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async source(trackId, mime): Promise<AudioSource> {
      let url = urls.get(trackId);
      if (url === undefined) {
        const file = await (await (await dir()).getFileHandle(trackId)).getFile();
        // `new Blob([file])` — без копирования: Blob ссылается на файл.
        const created = deps.createObjectURL(new Blob([file], { type: mime }));
        // Параллельный вызов мог успеть раньше: лишний адрес сразу отзываем.
        const existing = urls.get(trackId);
        if (existing === undefined) urls.set(trackId, created);
        else deps.revokeObjectURL(created);
        url = existing ?? created;
      }
      return { mime, mode: 'direct', url };
    },
    async usage() {
      const e = await deps.estimate();
      return { bytes: e.usage ?? 0, quota: e.quota ?? null };
    },
  };
}

/* v8 ignore start -- привязка к браузерным API: проверяется e2e (Chromium) */
/**
 * OPFS браузера: нужны `getDirectory` и воркеры. `createSyncAccessHandle` в основном потоке не виден (метод открыт
 * только воркерам), поэтому проверить его здесь нельзя: он есть везде, где есть OPFS (Safari 15.2+, Chrome 102+).
 */
export function browserOpfsDeps(): OpfsDeps {
  return {
    createObjectURL: blob => URL.createObjectURL(blob),
    estimate: () => navigator.storage.estimate(),
    getRoot: () => navigator.storage.getDirectory() as unknown as Promise<DirLike>,
    revokeObjectURL: url => URL.revokeObjectURL(url),
    supported: () =>
      typeof Worker !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.storage?.getDirectory === 'function',
  };
}
/* v8 ignore stop */
