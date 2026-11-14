/// <reference lib="webworker" />
// Воркер скачивания: запись в OPFS через `createSyncAccessHandle` (только в воркере; Safari не умеет `createWritable`
// в основном потоке). Логика — в `worker-core.ts` и `download.ts` (покрыты unit-тестами); здесь только привязка к OPFS.
import { TRACKS_DIR } from './opfs-storage';
import type { Sink } from './download';
import { createWorkerCore } from './worker-core';
import type { WorkerRequest } from './types';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const core = createWorkerCore({
  fetch: (url, init) => fetch(url, init),
  openSink: async trackId => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(TRACKS_DIR, { create: true });
    const file = await dir.getFileHandle(trackId, { create: true });
    const handle = await file.createSyncAccessHandle();
    const sink: Sink = {
      flush: () => handle.flush(),
      size: () => handle.getSize(),
      truncate: size => handle.truncate(size),
      write: (chunk, at) => {
        const written = handle.write(chunk, { at });
        if (written !== chunk.byteLength) throw new DOMException('short write', 'QuotaExceededError');
      },
    };
    return { close: () => handle.close(), sink };
  },
  post: message => scope.postMessage(message),
});

scope.onmessage = (e: MessageEvent<WorkerRequest>) => core.handle(e.data);
