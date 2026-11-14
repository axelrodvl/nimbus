import { describe, expect, it, vi } from 'vitest';
import { createTabs, type ChannelLike, type LockManagerLike } from './tabs';

describe('вкладки', () => {
  it('имя блокировки и канала задаётся (офлайн-менеджер: nimbus-offline), по умолчанию — nimbus-sync', () => {
    const names: string[] = [];
    const lockNames: string[] = [];
    const channel = (n: string): ChannelLike => {
      names.push(n);
      return { close: () => undefined, onmessage: null, postMessage: () => undefined };
    };
    const locks: LockManagerLike = {
      request: (n, _o, cb) => {
        lockNames.push(n);
        return Promise.resolve(cb());
      },
    };
    const onLead = vi.fn();
    createTabs({ channel, locks, name: 'nimbus-offline' }).lead(onLead);
    createTabs({ channel, locks }).lead(() => undefined);
    expect(names).toEqual(['nimbus-offline', 'nimbus-sync']);
    expect(lockNames).toEqual(['nimbus-offline', 'nimbus-sync']);
    expect(onLead).toHaveBeenCalledOnce();
  });
});
