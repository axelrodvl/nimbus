import { describe, expect, it } from 'vitest';
import { offlineHarness } from '@/test/offline';
import { installOfflineE2eHook, type OfflineE2eHook } from './e2e-hook';

describe('e2e-хук офлайна', () => {
  it('управляет менеджером и отдаёт состояние простыми объектами', async () => {
    const h = offlineHarness();
    await h.start();
    const target: { __nimbus?: { offline?: OfflineE2eHook; other?: number } } = { __nimbus: { other: 1 } };
    installOfflineE2eHook(h.manager, h.status, target);
    const hook = target.__nimbus!.offline!;
    expect(target.__nimbus!.other).toBe(1);
    await hook.pin('track', 1);
    await h.settle();
    expect(hook.state()).toMatchObject({
      activeCount: 1,
      blocked: 'none',
      files: { 1: { state: 'downloading' } },
      pins: ['track:1'],
    });
    hook.setPaused(true);
    expect(hook.state().blocked).toBe('paused');
    hook.retry(1);
    await hook.unpin('track', 1);
    await hook.removeAll();
    expect(hook.state().pins).toEqual([]);
  });
});
