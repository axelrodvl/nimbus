import { act } from '@testing-library/react';
import { vi } from 'vitest';
import { createOfflineRuntime, installOffline, type OfflineManager, type OfflineRuntime } from '@/lib/offline';
import type { OfflineFileStatus } from '@/lib/offline/status';
import { MemoryStorage } from './offline';

export type FakeManager = {
  pin: ReturnType<typeof vi.fn>;
  unpin: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  setPaused: ReturnType<typeof vi.fn>;
  removeAll: ReturnType<typeof vi.fn>;
  isPinned: ReturnType<typeof vi.fn>;
};

type Extra = Partial<ReturnType<OfflineRuntime['status']['getState']>>;
export type OfflineUi = {
  rt: OfflineRuntime;
  manager: FakeManager;
  /** Задаёт состояние файлов (и, если нужно, остальные поля состояния). */
  set: (files: Record<number, OfflineFileStatus>, extra?: Extra) => void;
};

export const fileStatus = (
  state: OfflineFileStatus['state'],
  bytesDone = 0,
  bytesTotal: number | null = null,
): OfflineFileStatus => ({
  bytesDone,
  bytesTotal,
  error: null,
  mime: 'audio/mpeg',
  state,
});

/**
 * Офлайн-окружение для тестов интерфейса: `supported`, поддельный менеджер (закрепления отражаются в `pins`),
 * состояние файлов задаётся `ui.set(...)`.
 */
export function installOfflineUi(over: { supported?: boolean } = {}): OfflineUi {
  const storage = new MemoryStorage();
  storage.supported = over.supported ?? true;
  const rt = createOfflineRuntime(over.supported === false ? null : storage);
  const manager: FakeManager = {
    isPinned: vi.fn(),
    pin: vi.fn(async (kind: string, id: number) => {
      const s = rt.status.getState();
      rt.status.setState({
        pinTimes: { ...s.pinTimes, [`${kind}:${id}`]: 1 },
        pins: new Set([...s.pins, `${kind}:${id}`]),
      });
    }),
    removeAll: vi.fn(async () => undefined),
    retry: vi.fn(),
    setPaused: vi.fn(),
    unpin: vi.fn(async (kind: string, id: number) => {
      const s = rt.status.getState();
      const pins = new Set(s.pins);
      pins.delete(`${kind}:${id}`);
      rt.status.setState({ pins });
    }),
  };
  rt.manager = manager as unknown as OfflineManager;
  installOffline(rt);
  return { manager, rt, set: (files, extra) => setFiles(rt, files, extra) };
}

/** Состояние файлов и закреплений; изменение оборачивается в `act`. */
function setFiles(rt: OfflineRuntime, files: Record<number, OfflineFileStatus>, extra: Extra = {}) {
  act(() => {
    rt.status.setState({ files: new Map(Object.entries(files).map(([id, f]) => [Number(id), f])), ...extra });
  });
}
