import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppData } from '@/lib/app-data';
import { createOfflineRuntime, installOffline, type OfflineRuntime } from '@/lib/offline';
import { MemoryStorage } from '@/test/offline';
import { pt, queue, setup } from '@/test/player';
import { seed } from '@/test/seed';
import type { AudioSource } from './audio/types';
import { TRANSCODE_SEEK_DEBOUNCE_MS } from './controller';
import { resolveStreamUrl } from './stream';
import { canPlay } from './track';

// IndexedDB в тестах живёт на `setImmediate`: его часы не подменяем.
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(async () => {
  vi.useRealTimers();
  installOffline(null);
  await resetAppData(true);
});

function withOffline(done: number[], downloading: number[] = []): { rt: OfflineRuntime; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const rt = createOfflineRuntime(storage);
  const file = (state: 'done' | 'downloading') => ({
    bytesDone: 1,
    bytesTotal: 1,
    error: null,
    mime: 'audio/flac',
    state,
  });
  rt.status.setState({
    files: new Map([
      ...done.map(id => [id, file('done')] as const),
      ...downloading.map(id => [id, file('downloading')] as const),
    ]),
  });
  installOffline(rt);
  return { rt, storage };
}

describe('адрес потока: скачанные треки', () => {
  it('скачанный трек играет из файла, всегда direct, даже если на сервере перекодируется; ?t= не используется', async () => {
    withOffline([5]);
    const src = await resolveStreamUrl(pt(5, { playback: 'transcode' }), 42);
    expect(src).toEqual({ mime: 'audio/flac', mode: 'direct', url: 'blob:mem/5' });
  });

  it('нескачанный трек — сетевой адрес, синхронно', () => {
    withOffline([5], [6]);
    expect(resolveStreamUrl(pt(6), 0)).toEqual({ headers: {}, mode: 'direct', url: '/api/tracks/6/stream' });
    expect(resolveStreamUrl(pt(7, { playback: 'transcode' }), 3)).toMatchObject({
      mode: 'transcode',
      url: '/api/tracks/7/stream?t=3.000',
    });
  });
});

describe('canPlay', () => {
  it('скачан — можно без связи; не скачан — нужна связь и статус found/ready', () => {
    seed({});
    withOffline([1]);
    expect(canPlay({ id: 1, status: 'adding' })).toBe(true);
    expect(canPlay({ id: 2, status: 'found' })).toBe(true);
    expect(canPlay({ id: 2, status: 'ready' })).toBe(true);
    expect(canPlay({ id: 2, status: 'adding' })).toBe(false);
    expect(canPlay({ status: 'found' })).toBe(true);
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    expect(canPlay({ id: 1, status: 'ready' })).toBe(true);
    expect(canPlay({ id: 2, status: 'ready' })).toBe(false);
    expect(canPlay({ status: 'ready' })).toBe(false);
  });
});

describe('контроллер и скачанные треки', () => {
  const offlineDeps = (ids: Set<number>) => ({
    isOffline: (id: number) => ids.has(id),
    offlineBroken: vi.fn((id: number) => void ids.delete(id)),
    prepareOffline: vi.fn(),
  });

  it('перекодируемый, но скачанный трек: перемотка — seek в файле, а не новый запрос ?t=', () => {
    const ids = new Set([1]);
    const deps = offlineDeps(ids);
    const s = setup(deps, [pt(1, { playback: 'transcode' })]);
    s.ctl.play(s.library.get(1)!, queue(s));
    expect(s.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1 }), 0);
    s.ctl.seekTo(5);
    vi.advanceTimersByTime(TRANSCODE_SEEK_DEBOUNCE_MS * 2);
    expect(s.engine.seeks.at(-1)).toBe(5);
    expect(s.engine.loads).toHaveLength(1);
  });

  it('тот же трек не скачан — перемотка перезапускает поток с ?t=', () => {
    const s = setup(offlineDeps(new Set()), [pt(1, { playback: 'transcode' })]);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.ctl.seekTo(5);
    vi.advanceTimersByTime(TRANSCODE_SEEK_DEBOUNCE_MS * 2);
    expect(s.engine.loads).toHaveLength(2);
    expect(s.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1 }), 5);
  });

  it('повтор перекодируемого скачанного трека — seek(0), без нового запроса потока', async () => {
    const ids = new Set([1]);
    const s = setup(offlineDeps(ids), [pt(1, { playback: 'transcode' })]);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    s.ctl.cycleRepeat();
    s.ctl.cycleRepeat(); // повтор одного
    s.engine.emit({ type: 'ended' });
    expect(s.engine.loads).toHaveLength(1);
    expect(s.engine.seeks.at(-1)).toBe(0);
  });

  it('ошибка воспроизведения скачанного файла: файл помечается повреждённым, трек играет по сети с той же позиции', () => {
    const ids = new Set([1]);
    const deps = offlineDeps(ids);
    const s = setup(deps, [pt(1)]);
    s.ctl.play(s.library.get(1)!, queue(s));
    s.engine.emit({ type: 'playing' });
    s.engine.position = { buffered: [], current: 12, duration: 100 };
    s.engine.emit({ code: 'media', type: 'error' });
    expect(deps.offlineBroken).toHaveBeenCalledWith(1);
    expect(s.engine.loads).toHaveLength(2);
    expect(s.engine.loads[1]!.opts).toMatchObject({ autoplay: true, startAt: 12 });
    expect(s.probe).not.toHaveBeenCalled();
    // Вторая ошибка уже сетевого потока — обычная расшифровка.
    s.engine.emit({ code: 'media', type: 'error' });
    expect(s.probe).toHaveBeenCalledOnce();
  });

  it('трек доскачали во время сетевого воспроизведения: ошибка потока — не повод считать файл повреждённым', () => {
    const ids = new Set<number>();
    const deps = offlineDeps(ids);
    const s = setup(deps, [pt(1)]);
    s.ctl.play(s.library.get(1)!, queue(s));
    ids.add(1); // файл появился уже после загрузки сетевого потока
    s.engine.emit({ code: 'media', type: 'error' });
    expect(deps.offlineBroken).not.toHaveBeenCalled();
    expect(s.probe).toHaveBeenCalledOnce();
  });

  it('источник скачанного трека готовится заранее: текущий и следующий', () => {
    const deps = offlineDeps(new Set([1, 2]));
    const s = setup(
      deps,
      [1, 2, 3].map(i => pt(i)),
    );
    s.ctl.play(s.library.get(1)!, queue(s));
    expect(deps.prepareOffline.mock.calls.map(c => c[0])).toEqual(expect.arrayContaining([1, 2]));
    deps.prepareOffline.mockClear();
    s.ctl.next();
    expect(deps.prepareOffline).toHaveBeenCalledWith(2);
    expect(deps.prepareOffline).toHaveBeenCalledWith(3);
  });

  it('асинхронный источник (скачанный, не подготовленный) допускается', async () => {
    const src: AudioSource = { mode: 'direct', url: 'blob:x' };
    const s = setup({ resolveStreamUrl: async () => src }, [pt(1)]);
    s.ctl.play(s.library.get(1)!, queue(s));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.engine.lastLoad?.src).toBe(src);
  });
});
