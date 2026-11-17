import { describe, expect, it } from 'vitest';
import { offlineHarness, offlineRows } from '@/test/offline';
import { makeTrack } from '@/test/factories';

/** Замер: 5 000 закреплённых файлов, 100 сообщений прогресса — время и число обновлений store. */
describe('perf: офлайн-менеджер', () => {
  it('100 сообщений прогресса при 5 000 файлов', async () => {
    const rows = offlineRows();
    rows.tracks = Array.from({ length: 5000 }, (_, i) =>
      makeTrack({ album_id: 1, id: i + 1, position: i + 1, status: 'ready' }),
    );
    const h = offlineHarness({ rows, settings: { concurrency: 4 } });
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    let notifications = 0;
    h.status.subscribe(() => notifications++);
    const t0 = performance.now();
    for (let i = 1; i <= 100; i++) {
      await h.emit({
        bytesDone: i,
        bytesTotal: 1000,
        etag: '"e"',
        mime: 'audio/flac',
        resumable: true,
        trackId: String((i % 4) + 1),
        type: 'progress',
      });
    }
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`perf: offline 100 progress @5000 files = ${ms.toFixed(1)} ms, ${notifications} notifications`);
    expect(notifications).toBeLessThan(5);
  });
});
