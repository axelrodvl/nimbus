'use client';

import { useRouter } from 'next/navigation';
import { createContext, startTransition, useContext, useRef, useState } from 'react';
import { revalidateLibrary } from '@/app/actions/library';
import { useLiveEvent } from '@/hooks/use-live-events';
import type { TrackStatus } from '@/lib/api/events';

export type TrackOverride = { status: TrackStatus; reason: string | null };
export type AlbumProgress = { stage: 'searching' | 'verifying'; done: number; total: number };

type LiveLibraryValue = {
  /** Последние статусы, пришедшие по WebSocket, поверх серверных значений. */
  trackStatus: ReadonlyMap<number, TrackOverride>;
  albumProgress: ReadonlyMap<number, AlbumProgress>;
};

const LiveLibraryContext = createContext<LiveLibraryValue>({ albumProgress: new Map(), trackStatus: new Map() });

const TRACK_REFRESH_MS = 2000;
const LIBRARY_REFRESH_MS = 1000;

// Клиентский store live-обновлений + отложенная перезагрузка серверных данных:
// - `track.status` — мгновенно обновляет бейджи, сводки пересчитываются через router.refresh() (debounce 2 с);
// - `job.progress` — прогресс для tooltip и шапки альбома;
// - `library.changed` / `resync` — инвалидация кэша и router.refresh() (debounce 1 с).
export function LiveLibrarySync({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [trackStatus, setTrackStatus] = useState<ReadonlyMap<number, TrackOverride>>(new Map());
  const [albumProgress, setAlbumProgress] = useState<ReadonlyMap<number, AlbumProgress>>(new Map());
  const timer = useRef<{ id: ReturnType<typeof setTimeout>; due: number } | null>(null);
  const pendingTags = useRef(new Set<string>());

  function scheduleRefresh(delayMs: number, tags: string[]) {
    tags.forEach(t => pendingTags.current.add(t));
    const due = Date.now() + delayMs;
    if (timer.current && timer.current.due <= due) return;
    if (timer.current) clearTimeout(timer.current.id);
    const id = setTimeout(() => {
      timer.current = null;
      const batch = [...pendingTags.current];
      pendingTags.current.clear();
      void revalidateLibrary(batch).then(() => startTransition(() => router.refresh()));
    }, delayMs);
    timer.current = { due, id };
  }

  useLiveEvent('track.status', e => {
    setTrackStatus(prev => new Map(prev).set(e.track_id, { reason: e.reason, status: e.status }));
    scheduleRefresh(TRACK_REFRESH_MS, ['library', `album:${e.album_id}`]);
  });

  useLiveEvent('job.progress', e => {
    setAlbumProgress(prev => {
      const next = new Map(prev);
      // Завершённый этап проверки больше не показываем.
      if (e.stage === 'verifying' && e.total > 0 && e.done >= e.total) next.delete(e.album_id);
      else next.set(e.album_id, { done: e.done, stage: e.stage, total: e.total });
      return next;
    });
  });

  useLiveEvent('library.changed', e => scheduleRefresh(LIBRARY_REFRESH_MS, ['library', `${e.entity}:${e.id}`]));

  useLiveEvent('resync', () => {
    setTrackStatus(new Map());
    scheduleRefresh(LIBRARY_REFRESH_MS, ['library']);
  });

  return <LiveLibraryContext value={{ albumProgress, trackStatus }}>{children}</LiveLibraryContext>;
}

export function useLiveLibrary() {
  return useContext(LiveLibraryContext);
}

/** Актуальный статус трека: live-значение, если оно пришло, иначе серверное. */
export function useTrackStatus(trackId: number, status: TrackStatus, reason: string | null): TrackOverride {
  const override = useLiveLibrary().trackStatus.get(trackId);
  return override ?? { reason, status };
}

export function useAlbumProgress(albumId: number): AlbumProgress | undefined {
  return useLiveLibrary().albumProgress.get(albumId);
}
