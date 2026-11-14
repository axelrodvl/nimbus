import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { createDb } from '@/lib/db';
import { makeTrack, resetFactories } from '@/test/factories';
import { createLibraryStore } from './library';
import { createMutations } from './mutations';

let n = 0;
beforeEach(resetFactories);

function setup(opts: { online?: boolean; dbName?: string; postPlayed?: (id: number) => Promise<unknown> } = {}) {
  const db = createDb({ name: opts.dbName ?? `mut-${++n}` });
  const store = createLibraryStore();
  store.getState().hydrate({
    albums: [],
    artists: [],
    playlistTracks: [],
    playlists: [],
    tracks: [makeTrack({ id: 1, play_count: 2 }), makeTrack({ id: 2 })],
  });
  const requestSync = vi.fn();
  const online = { value: opts.online ?? true };
  const postPlayed = vi.fn(opts.postPlayed ?? (async () => undefined));
  const mutations = createMutations({
    db,
    isOnline: () => online.value,
    now: () => Date.parse('2026-05-05T00:00:00Z'),
    postPlayed,
    requestSync,
    store,
  });
  return { db, mutations, online, postPlayed, requestSync, store };
}

describe('mutate', () => {
  it('успех: apply → request → синхронизация, результат возвращается', async () => {
    const { mutations, requestSync } = setup();
    const apply = vi.fn();
    const rollback = vi.fn();
    const result = await mutations.mutate({ apply, request: async () => 42, rollback });
    expect(result).toBe(42);
    expect(apply).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(requestSync).toHaveBeenCalledWith('mutation');
  });

  it('ошибка запроса: откат и ApiError', async () => {
    const { mutations, requestSync } = setup();
    const rollback = vi.fn();
    const error = new ApiError(409, 'conflict', 'dup');
    await expect(
      mutations.mutate({
        apply: () => undefined,
        request: async () => {
          throw error;
        },
        rollback,
      }),
    ).rejects.toBe(error);
    expect(rollback).toHaveBeenCalledOnce();
    expect(requestSync).not.toHaveBeenCalled();
  });

  it('произвольная ошибка оборачивается в ApiError, сетевая — в offline', async () => {
    const { mutations } = setup();
    const run = (e: unknown) =>
      mutations.mutate({
        apply: () => undefined,
        request: async () => {
          throw e;
        },
        rollback: () => undefined,
      });
    await expect(run(new Error('weird'))).rejects.toMatchObject({ code: 'unknown', message: 'weird' });
    await expect(run('str')).rejects.toMatchObject({ code: 'unknown', message: 'str' });
    await expect(run(new ApiError(0, 'network', 'down'))).rejects.toMatchObject({ code: 'offline', status: 0 });
  });

  it('без сети: ошибка offline, store не трогается, запрос не идёт', async () => {
    const { mutations } = setup({ online: false });
    const apply = vi.fn();
    const request = vi.fn(async () => 1);
    await expect(mutations.mutate({ apply, request, rollback: () => undefined })).rejects.toMatchObject({
      code: 'offline',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('recordPlay и outbox', () => {
  it('онлайн: счётчик растёт сразу, запрос уходит, затем синхронизация', async () => {
    const { mutations, postPlayed, requestSync, store } = setup();
    await mutations.recordPlay(1);
    expect(store.getState().tracks.get(1)).toMatchObject({
      last_played_at: '2026-05-05T00:00:00.000Z',
      play_count: 3,
    });
    expect(postPlayed).toHaveBeenCalledWith(1);
    expect(requestSync).toHaveBeenCalledWith('played');
  });

  it('нет сети: запись кладётся в outbox, оптимистичный счётчик остаётся', async () => {
    const { db, mutations, postPlayed, store } = setup({ online: false });
    await mutations.recordPlay(1);
    expect(postPlayed).not.toHaveBeenCalled();
    expect(store.getState().tracks.get(1)?.play_count).toBe(3);
    expect((await db.outboxAll()).map(o => o.trackId)).toEqual([1]);
  });

  it('сеть/5xx при отправке: запись откладывается', async () => {
    for (const error of [new ApiError(0, 'network', 'x'), new ApiError(503, 'unavailable', 'x')]) {
      const { db, mutations } = setup({
        postPlayed: async () => {
          throw error;
        },
      });
      await mutations.recordPlay(2);
      expect((await db.outboxAll()).map(o => o.trackId)).toEqual([2]);
    }
  });

  it('4xx: откат счётчика и ошибка, в outbox ничего нет', async () => {
    const { db, mutations, store } = setup({
      postPlayed: async () => {
        throw new ApiError(404, 'not_found', 'no track');
      },
    });
    await expect(mutations.recordPlay(1)).rejects.toMatchObject({ code: 'not_found' });
    expect(store.getState().tracks.get(1)?.play_count).toBe(2);
    expect(await db.outboxAll()).toEqual([]);
  });

  it('трек, которого нет в store, не мешает отправке', async () => {
    const { mutations, postPlayed } = setup();
    await mutations.recordPlay(999);
    expect(postPlayed).toHaveBeenCalledWith(999);
    const failing = setup({
      postPlayed: async () => {
        throw new ApiError(400, 'bad', 'x');
      },
    });
    await expect(failing.mutations.recordPlay(999)).rejects.toBeInstanceOf(ApiError);
  });

  it('outbox переживает «перезапуск» (новый экземпляр на той же базе) и отправляется по порядку', async () => {
    const dbName = `mut-restart-${++n}`;
    const offline = setup({ dbName, online: false });
    await offline.mutations.recordPlay(1);
    await offline.mutations.recordPlay(2);
    await offline.mutations.recordPlay(1);
    offline.db.close();

    const sent: number[] = [];
    const restarted = setup({
      dbName,
      postPlayed: async id => {
        sent.push(id);
      },
    });
    await restarted.mutations.flushOutbox();
    expect(sent).toEqual([1, 2, 1]);
    expect(await restarted.db.outboxAll()).toEqual([]);
    expect(restarted.requestSync).toHaveBeenCalledWith('outbox');
  });

  it('flush: 4xx отбрасывает запись и идёт дальше, 5xx/сеть — оставляет и останавливается', async () => {
    const failFor = new Map<number, ApiError>([
      [10, new ApiError(404, 'not_found', 'gone')],
      [20, new ApiError(503, 'unavailable', 'later')],
    ]);
    const { db, mutations, postPlayed } = setup({
      postPlayed: async id => {
        const e = failFor.get(id);
        if (e) throw e;
      },
    });
    for (const trackId of [10, 20, 30]) await db.outboxAdd({ at: 1, trackId });
    await mutations.flushOutbox();
    expect(postPlayed.mock.calls.map(c => c[0])).toEqual([10, 20]);
    expect((await db.outboxAll()).map(o => o.trackId)).toEqual([20, 30]);

    failFor.delete(20);
    await mutations.flushOutbox();
    expect(await db.outboxAll()).toEqual([]);
  });

  it('flush одиночный: параллельные вызовы делят одну отправку', async () => {
    const { db, mutations, postPlayed } = setup();
    await db.outboxAdd({ at: 1, trackId: 5 });
    await Promise.all([mutations.flushOutbox(), mutations.flushOutbox()]);
    expect(postPlayed).toHaveBeenCalledTimes(1);
  });

  it('start() отправляет накопленное сразу и при событии online; stop() отписывает', async () => {
    const { db, mutations, postPlayed } = setup();
    await db.outboxAdd({ at: 1, trackId: 7 });
    mutations.start();
    mutations.start(); // повторный старт безопасен
    await vi.waitFor(() => expect(postPlayed).toHaveBeenCalledWith(7));
    await vi.waitFor(async () => expect(await db.outboxAll()).toEqual([]));

    await db.outboxAdd({ at: 2, trackId: 8 });
    globalThis.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(postPlayed).toHaveBeenCalledWith(8));

    mutations.stop();
    await db.outboxAdd({ at: 3, trackId: 9 });
    globalThis.dispatchEvent(new Event('online'));
    await new Promise(r => setTimeout(r, 20));
    expect(postPlayed).not.toHaveBeenCalledWith(9);
  });
});
