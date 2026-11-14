import type { Batch } from '@/lib/db/types';

export type TabMessage = { type: 'batch'; batch: Batch } | { type: 'reload' };

export const LOCK_NAME = 'nimbus-sync';
export const CHANNEL_NAME = 'nimbus-sync';

export type LockManagerLike = {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<unknown>): Promise<unknown>;
};
export type ChannelLike = {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
};

export type TabsDeps = {
  /** `navigator.locks`; без него каждая вкладка сама себе лидер. */
  locks?: LockManagerLike | null;
  /** Фабрика канала; без неё вкладки не обмениваются сообщениями. */
  channel?: ((name: string) => ChannelLike) | null;
};

/** Согласование вкладок: синхронизирует одна (лидер, Web Lock), остальные получают её пачки по BroadcastChannel. */
export interface Tabs {
  /** Вызывает `onLead`, когда вкладка стала лидером (сразу или когда прежний лидер закрылся). */
  lead(onLead: () => void): void;
  post(message: TabMessage): void;
  onMessage(listener: (message: TabMessage) => void): void;
  close(): void;
}

export function createTabs(deps: TabsDeps = {}): Tabs {
  const locks =
    deps.locks === undefined ? (globalThis.navigator?.locks as LockManagerLike | undefined) : (deps.locks ?? undefined);
  const make =
    deps.channel === undefined
      ? typeof BroadcastChannel === 'undefined'
        ? null
        : (n: string) => new BroadcastChannel(n) as ChannelLike
      : deps.channel;
  const channel = make?.(CHANNEL_NAME) ?? null;
  const abort = new AbortController();
  let release: () => void = () => {};

  return {
    close() {
      abort.abort();
      release();
      if (channel) channel.onmessage = null;
      channel?.close();
    },
    lead(onLead) {
      if (!locks) {
        onLead();
        return;
      }
      // Лок держится, пока вкладка жива: промис не завершается до `close()`.
      locks
        .request(LOCK_NAME, { signal: abort.signal }, () => {
          onLead();
          return new Promise<void>(resolve => (release = resolve));
        })
        .catch(() => {
          // Запрос отменён закрытием вкладки/движка — лидерство не нужно.
        });
    },
    onMessage(listener) {
      if (channel) channel.onmessage = e => listener(e.data as TabMessage);
    },
    post(message) {
      channel?.postMessage(message);
    },
  };
}
