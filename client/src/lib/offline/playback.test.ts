import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '@/test/offline';
import { createOfflinePlayback, SOURCE_CACHE_SIZE } from './playback';
import { createOfflineStatusStore, type OfflineFileStatus } from './status';

const file = (state: OfflineFileStatus['state'] = 'done'): OfflineFileStatus => ({
  bytesDone: 1,
  bytesTotal: 1,
  error: null,
  mime: 'audio/flac',
  state,
});

function setup(ids: Record<number, OfflineFileStatus['state']> = { 1: 'done', 2: 'done', 3: 'done' }) {
  const storage = new MemoryStorage();
  const status = createOfflineStatusStore(true);
  const setFiles = (m: Record<number, OfflineFileStatus['state']>) =>
    status.setState({ files: new Map(Object.entries(m).map(([k, v]) => [Number(k), file(v)])) });
  setFiles(ids);
  const markBroken = vi.fn();
  const playback = createOfflinePlayback({ markBroken, status, storage });
  return { markBroken, playback, setFiles, status, storage };
}

describe('воспроизведение скачанных треков', () => {
  it('готовый трек — источник direct с типом из записи; неготовый и неизвестный — null (сеть)', async () => {
    const { playback } = setup({ 1: 'done', 2: 'downloading' });
    expect(playback.has(1)).toBe(true);
    expect(playback.has(2)).toBe(false);
    expect(playback.resolve(2)).toBeNull();
    expect(playback.resolve(3)).toBeNull();
    expect(await playback.resolve(1)).toEqual({ mime: 'audio/flac', mode: 'direct', url: 'blob:mem/1' });
  });

  it('подготовленный заранее источник отдаётся синхронно (жест iOS)', async () => {
    const { playback, storage } = setup();
    expect(playback.resolve(1)).toBeInstanceOf(Promise);
    playback.prepare(2);
    await vi.waitFor(() => expect(storage.sourced).toContain('2'));
    await Promise.resolve();
    const src = playback.resolve(2);
    expect(src).not.toBeInstanceOf(Promise);
    expect(src).toMatchObject({ url: 'blob:mem/2' });
    playback.prepare(2); // уже в кэше — повторно не открывается
    expect(storage.sourced.filter(i => i === '2')).toHaveLength(1);
    playback.prepare(404); // нет файла — ничего
  });

  it('параллельные запросы одного трека открывают источник один раз', async () => {
    const { playback, storage } = setup();
    await Promise.all([playback.resolve(1), playback.resolve(1)]);
    expect(storage.sourced).toEqual(['1']);
  });

  it('кэш из трёх источников (текущий, следующий, запасной): при смене трека самый старый отзывается', async () => {
    expect(SOURCE_CACHE_SIZE).toBe(3);
    const { playback, storage } = setup({ 1: 'done', 2: 'done', 3: 'done', 4: 'done' });
    await playback.resolve(1);
    await playback.resolve(2);
    await playback.resolve(3);
    expect(storage.released).toEqual([]);
    await playback.resolve(4);
    expect(storage.released).toEqual(['1']);
    // Обращение освежает запись: 2 теперь свежее 3 и 4.
    expect(playback.resolve(2)).not.toBeInstanceOf(Promise);
    await playback.resolve(1);
    expect(storage.released).toEqual(['1', '3']);
  });

  it('файл перестал быть готовым (удалён, возвращён в очередь) — источник освобождается', async () => {
    const { playback, setFiles, storage } = setup();
    await playback.resolve(1);
    await playback.resolve(2);
    setFiles({ 1: 'done', 2: 'queued' });
    expect(storage.released).toEqual(['2']);
    setFiles({ 1: 'done', 2: 'queued' }); // без изменений состава — не отзываем дважды
    expect(storage.released).toEqual(['2']);
  });

  it('повреждённый файл: источник освобождён, менеджеру сообщено, трек считается недоступным до перекачки', async () => {
    const { markBroken, playback, setFiles, storage } = setup();
    await playback.resolve(1);
    playback.broken(1);
    expect(storage.released).toEqual(['1']);
    expect(markBroken).toHaveBeenCalledWith(1);
    expect(playback.has(1)).toBe(false);
    expect(playback.resolve(1)).toBeNull();
    setFiles({ 1: 'queued', 2: 'done' }); // менеджер вернул в очередь
    setFiles({ 1: 'done', 2: 'done' }); // перекачан
    expect(playback.has(1)).toBe(true);
  });

  it('ошибка открытия файла пробрасывается; подготовка её не бросает', async () => {
    const { playback, storage } = setup();
    storage.failSource = true;
    await expect(playback.resolve(1)).rejects.toThrow('no file');
    expect(() => playback.prepare(2)).not.toThrow();
    await Promise.resolve();
    await expect(playback.resolve(1)).rejects.toThrow('no file'); // повтор разрешён
  });

  it('версия и подписка: меняются только когда меняется набор доступных без сети треков', () => {
    const { playback, setFiles } = setup({ 1: 'done' });
    const seen = vi.fn();
    const off = playback.subscribe(seen);
    const v0 = playback.version();
    setFiles({ 1: 'done' }); // тот же набор — тишина
    expect(seen).not.toHaveBeenCalled();
    setFiles({ 1: 'done', 2: 'downloading' }); // качается — ещё не доступен
    expect(seen).not.toHaveBeenCalled();
    setFiles({ 1: 'done', 2: 'done' });
    expect(seen).toHaveBeenCalledOnce();
    expect(playback.version()).toBe(v0 + 1);
    setFiles({ 1: 'done', 3: 'done' }); // тот же размер, другой состав
    expect(seen).toHaveBeenCalledTimes(2);
    playback.broken(1);
    expect(seen).toHaveBeenCalledTimes(3);
    off();
    setFiles({});
    expect(seen).toHaveBeenCalledTimes(3);
  });
});
