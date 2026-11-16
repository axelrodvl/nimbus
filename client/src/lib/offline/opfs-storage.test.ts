import { describe, expect, it, vi } from 'vitest';
import { createOpfsStorage, type DirLike, type OpfsDeps } from './opfs-storage';

class NotFound extends Error {
  name = 'NotFoundError';
}

/** Фейковый OPFS: каталог `tracks` с файлами (id → размер). */
function fakeOpfs(initial: Record<string, number> = {}) {
  const files = new Map(Object.entries(initial));
  const tracks: DirLike = {
    getDirectoryHandle: async () => tracks,
    getFileHandle: async name => {
      if (!files.has(name)) throw new NotFound();
      return { getFile: async () => new File([new Uint8Array(files.get(name)!)], name) };
    },
    keys: async function* () {
      yield* files.keys();
    },
    removeEntry: async name => {
      if (!files.delete(name)) throw new NotFound();
    },
  };
  const root: DirLike = { ...tracks, getDirectoryHandle: async () => tracks };
  const urls: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  const deps: OpfsDeps = {
    createObjectURL: () => {
      const u = `blob:x/${++n}`;
      urls.push(u);
      return u;
    },
    estimate: async () => ({ quota: 1000, usage: 100 }),
    getRoot: async () => root,
    revokeObjectURL: u => void revoked.push(u),
    supported: () => true,
  };
  return { deps, files, revoked, urls };
}

describe('OPFS-хранилище', () => {
  it('list, size и remove по файлам каталога tracks', async () => {
    const { deps, files } = fakeOpfs({ '1': 5, '2': 7 });
    const s = createOpfsStorage(deps);
    expect(s.isSupported()).toBe(true);
    expect((await s.list()).sort()).toEqual(['1', '2']);
    expect(await s.size('2')).toBe(7);
    expect(await s.size('9')).toBeNull();
    await s.remove('1');
    await s.remove('1'); // уже нет — не ошибка
    expect([...files.keys()]).toEqual(['2']);
  });

  it('не проглатывает чужие ошибки', async () => {
    const { deps } = fakeOpfs({ '1': 1 });
    const boom = new Error('io');
    deps.getRoot = async () =>
      ({
        getDirectoryHandle: async () => ({
          getDirectoryHandle: async () => {
            throw boom;
          },
          getFileHandle: async () => {
            throw boom;
          },
          keys: async function* () {},
          removeEntry: async () => {
            throw boom;
          },
        }),
      }) as unknown as DirLike;
    const s = createOpfsStorage(deps);
    await expect(s.size('1')).rejects.toBe(boom);
    await expect(s.remove('1')).rejects.toBe(boom);
  });

  it('source: объектный URL для файла, режим direct, повторный вызов — тот же URL; release отзывает', async () => {
    const { deps, revoked, urls } = fakeOpfs({ '1': 5 });
    const s = createOpfsStorage(deps);
    const a = await s.source('1', 'audio/flac');
    expect(a).toEqual({ mime: 'audio/flac', mode: 'direct', url: urls[0] });
    expect((await s.source('1', 'audio/flac')).url).toBe(urls[0]);
    s.release('1');
    s.release('1');
    expect(revoked).toEqual([urls[0]]);
  });

  it('параллельные source одного файла: лишний URL сразу отзывается', async () => {
    const { deps, revoked, urls } = fakeOpfs({ '1': 5 });
    const s = createOpfsStorage(deps);
    const [a, b] = await Promise.all([s.source('1', 'a/b'), s.source('1', 'a/b')]);
    expect(a.url).toBe(b.url);
    expect(urls).toHaveLength(2);
    expect(revoked).toEqual([urls[1]]);
  });

  it('remove отзывает URL (утечка адреса = утечка места на диске); source отсутствующего файла — ошибка', async () => {
    const { deps, revoked, urls } = fakeOpfs({ '1': 5 });
    const s = createOpfsStorage(deps);
    await s.source('1', 'a/b');
    await s.remove('1');
    expect(revoked).toEqual([urls[0]]);
    await expect(s.source('1', 'a/b')).rejects.toBeInstanceOf(NotFound);
  });

  it('usage — оценка браузера; без неё нули', async () => {
    const { deps } = fakeOpfs();
    expect(await createOpfsStorage(deps).usage()).toEqual({ bytes: 100, quota: 1000 });
    deps.estimate = vi.fn(async () => ({}));
    expect(await createOpfsStorage(deps).usage()).toEqual({ bytes: 0, quota: null });
  });
});
