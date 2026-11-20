import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePlaylistTrack, makeTrack } from '@/test/factories';
import { offlineFile, offlineHarness, offlineRows } from '@/test/offline';
import {
  ESTIMATED_TRACK_BYTES,
  MAX_ATTEMPTS,
  PERSIST_PROGRESS_MS,
  PROGRESS_PUBLISH_MS,
  RECONCILE_DEBOUNCE_MS,
  RETRY_DELAYS_MS,
  STATUS_BROADCAST_MS,
} from './manager';
import type { DownloadErrorCode, DownloadMessage } from './types';
import { albumOfflineState, FAVORITES_PIN_ID, playlistOfflineState, trackOfflineState } from './status';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

const done = (trackId: number, bytes = 100) =>
  ({ bytes, etag: '"e"', mime: 'audio/flac', resumable: true, trackId: String(trackId), type: 'done' }) as const;
const error = (
  trackId: number,
  over: Partial<{ code: DownloadErrorCode; retryable: boolean; bytesDone: number }> = {},
): DownloadMessage => ({
  bytesDone: 0,
  code: 'network',
  retryable: true,
  trackId: String(trackId),
  type: 'error',
  ...over,
});
const progress = (trackId: number, bytesDone: number, bytesTotal: number | null = 100, resumable = true) =>
  ({
    bytesDone,
    bytesTotal,
    etag: '"e"',
    mime: 'audio/flac',
    resumable,
    trackId: String(trackId),
    type: 'progress',
  }) as const;

describe('закрепления и сверка', () => {
  it('закрепление альбома ставит в очередь все его треки; первые concurrency — стартуют', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    expect([1, 2, 3].map(h.state)).toEqual(['downloading', 'downloading', 'downloading']);
    expect(h.downloader.startedIds).toEqual([1, 2, 3]);
    expect(h.downloader.started[0]).toEqual({
      etag: null,
      headers: {},
      offset: 0,
      trackId: '1',
      url: '/api/tracks/1/stream?download=1',
    });
    expect(h.status.getState().pins).toEqual(new Set(['album:1']));
    expect(h.manager.isPinned('album', 1)).toBe(true);
    expect(h.db.pins.get('album:1')).toMatchObject({ id: 1, kind: 'album' });
    expect(h.db.files.size).toBe(3);
  });

  it('повторное закрепление ничего не меняет; снятие незакреплённого — тоже', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('track', 1);
    await h.manager.pin('track', 1);
    await h.manager.unpin('track', 99);
    await h.settle();
    expect(h.downloader.startedIds).toEqual([1]);
  });

  it('порядок очереди: по времени закрепления, затем по позиции в альбоме (диск, номер)', async () => {
    const rows = {
      ...(await import('@/test/offline')).offlineRows(),
    };
    // В альбоме 1 трек 3 — на первом диске, трек 1 — на втором.
    rows.tracks = rows.tracks.map(t => (t.id === 1 ? { ...t, disc_no: 2 } : t));
    const h = offlineHarness({ rows, settings: { concurrency: 1 } });
    await h.start();
    await h.manager.pin('album', 2);
    vi.setSystemTime(2_000_000);
    await h.manager.pin('album', 1);
    await h.settle();
    const order: number[] = [...h.downloader.startedIds];
    for (let i = 0; i < 4; i++) {
      await h.emit(done(order[order.length - 1]!));
      order.push(...h.downloader.startedIds.slice(order.length));
    }
    // Альбом 2 закреплён раньше; в нём треки 4, 5 (6 — `adding`, ждёт); затем альбом 1: диск 1 → 2, 3, диск 2 → 1.
    expect(order).toEqual([4, 5, 2, 3, 1]);
  });

  it('трек в альбоме и в плейлисте: снято одно закрепление — файл остаётся, снято второе — удалён', async () => {
    const h = offlineHarness({ storage: { '2': 100 } });
    await h.start();
    await h.manager.pin('album', 1);
    await h.manager.pin('playlist', 1);
    await h.settle();
    await h.emit(done(2));
    await h.manager.unpin('album', 1);
    await h.settle();
    expect(h.state(2)).toBe('done');
    expect(h.state(1)).toBeUndefined();
    expect(h.downloader.aborted).toContain('1');
    await h.manager.unpin('playlist', 1);
    await h.settle();
    expect(h.state(2)).toBeUndefined();
    expect(h.storage.removed).toContain('2');
    expect(h.db.files.has(2)).toBe(false);
  });

  it('в закреплённый плейлист добавлен трек (дельта) — скачивается после debounce', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('playlist', 1);
    await h.settle();
    expect(h.downloader.startedIds).toEqual([2, 4]);
    h.library.getState().applyBatch({ playlistTracks: [makePlaylistTrack({ id: 3, playlist_id: 1, track_id: 5 })] });
    expect(h.state(5)).toBeUndefined(); // debounce 1 с
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS);
    await h.settle();
    expect(h.downloader.startedIds).toEqual([2, 4, 5]);
  });

  it('трек удалён из библиотеки — файл удалён и загрузка прервана', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    h.library.getState().applyBatch({ deleted: [{ entity: 'track', id: 3 }] });
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS);
    await h.settle();
    expect(h.state(3)).toBeUndefined();
    expect(h.downloader.aborted).toContain('3');
    expect(h.storage.removed).toContain('3');
  });

  it('трек вышел из библиотеки (in_library = false) — перестаёт быть нужен альбому', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    h.library
      .getState()
      .applyBatch({ tracks: [{ ...makeTrack({ album_id: 1, id: 2, position: 2 }), in_library: false }] });
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS);
    await h.settle();
    expect(h.state(2)).toBeUndefined();
    expect(h.state(1)).toBeDefined();
  });

  it('удалена сама сущность — закрепление снимается (альбом, плейлист, трек)', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('album', 1);
    await h.manager.pin('playlist', 1);
    await h.manager.pin('track', 5);
    await h.settle();
    h.library.getState().applyBatch({
      deleted: [
        { entity: 'playlist', id: 1 },
        { entity: 'album', id: 1 },
        { entity: 'track', id: 5 },
      ],
    });
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS);
    await h.settle();
    expect(h.status.getState().pins.size).toBe(0);
    expect(h.db.pins.size).toBe(0);
  });

  it('фаза 1 гидрации (треков ещё нет) — закрепления не снимаются; после треков сверка идёт как обычно', async () => {
    const { tracks: _tracks, ...core } = offlineRows();
    const h = offlineHarness({
      files: [offlineFile(1, { bytes_done: 5, state: 'done' })],
      hydrated: false,
      pins: [{ created_at: 1, id: 1, key: 'album:1', kind: 'album' }],
      storage: { '1': 5 },
    });
    h.library.getState().hydrate(core);
    await h.start();
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS);
    await h.settle();
    expect(h.db.pins.size).toBe(1);
    expect(h.state(1)).toBe('done');
    h.library.getState().hydrateTracks(offlineRows().tracks);
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS);
    await h.settle();
    expect(h.db.pins.size).toBe(1); // альбом 1 есть, закрепление живо
    expect(h.state(1)).toBe('done');
  });

  it('пока библиотека не загружена или идёт снимок — ничего не удаляется', async () => {
    const h = offlineHarness({
      files: [offlineFile(1, { bytes_done: 5, state: 'done' })],
      hydrated: false,
      pins: [{ created_at: 1, id: 1, key: 'album:1', kind: 'album' }],
      storage: { '1': 5 },
    });
    await h.start();
    expect(h.db.pins.size).toBe(1);
    expect(h.state(1)).toBe('done');
    // Снимок: библиотека пуста, но она неполна.
    let complete = false;
    const h2 = offlineHarness({
      deps: { libraryComplete: () => complete },
      files: [offlineFile(1, { bytes_done: 5, state: 'done' })],
      pins: [
        { created_at: 1, id: 1, key: 'album:1', kind: 'album' },
        { created_at: 2, id: 77, key: 'album:77', kind: 'album' },
      ],
      storage: { '1': 5 },
    });
    await h2.start();
    expect(h2.db.pins.size).toBe(2);
    expect(h2.state(1)).toBe('done');
    complete = true;
    h2.library.getState().applyBatch({ artists: [] });
    h2.library.getState().patchTrack(1, { title: 'x' });
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS);
    await h2.settle();
    expect([...h2.db.pins.keys()]).toEqual(['album:1']);
  });
});

describe('«Избранное» и время закрепления', () => {
  it('закрепление «Избранного» (playlist:0) качает его треки и следит за изменениями набора', async () => {
    let favorites = [1, 4];
    const h = offlineHarness({ deps: { favoriteIds: () => favorites } });
    await h.start();
    await h.manager.pin('playlist', FAVORITES_PIN_ID);
    await h.settle();
    expect(h.downloader.startedIds.sort()).toEqual([1, 4]);
    // Избранное изменилось вместе с библиотекой: лишний трек уходит, новый — в очередь.
    favorites = [1, 5];
    h.library.getState().applyBatch({ tracks: [{ ...makeTrack({ album_id: 2, id: 5, position: 2 }), play_count: 9 }] });
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS + 10);
    await h.settle();
    expect([...h.status.getState().files.keys()].sort()).toEqual([1, 5]);
    // Без функции «Избранное» не закрепляется: закрепление остаётся, но файлов нет.
    const bare = offlineHarness();
    await bare.start();
    await bare.manager.pin('playlist', FAVORITES_PIN_ID);
    await bare.settle();
    expect(bare.status.getState().files.size).toBe(0);
    expect(bare.status.getState().pins.has('playlist:0')).toBe(true);
  });

  it('время закрепления попадает в состояние', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('album', 1);
    expect(h.status.getState().pinTimes).toEqual({ 'album:1': 1_000_000 });
    await h.manager.unpin('album', 1);
    expect(h.status.getState().pinTimes).toEqual({});
  });
});

describe('очередь', () => {
  it('одновременно не больше concurrency; завершение запускает следующий', async () => {
    const h = offlineHarness({ settings: { concurrency: 2 } });
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    expect(h.downloader.startedIds).toEqual([1, 2]);
    expect(h.status.getState()).toMatchObject({ activeCount: 2, queueLength: 1 });
    await h.emit(done(1));
    expect(h.downloader.startedIds).toEqual([1, 2, 3]);
    expect(h.state(1)).toBe('done');
  });

  it('смена concurrency в настройках подхватывается', async () => {
    const h = offlineHarness({ settings: { concurrency: 1 } });
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    expect(h.downloader.startedIds).toEqual([1]);
    h.settings.update({ concurrency: 3 });
    await h.settle();
    expect(h.downloader.startedIds).toEqual([1, 2, 3]);
  });

  it('трек adding ждёт и стартует, когда статус стал found', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('track', 6);
    await h.settle();
    expect(h.state(6)).toBe('queued');
    expect(h.downloader.started).toEqual([]);
    h.library.getState().patchTrack(6, { status: 'found' });
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS);
    await h.settle();
    expect(h.state(6)).toBe('downloading');
  });

  it('прогресс обновляет состояние; в IndexedDB пишется не чаще раза в 2 с', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('track', 1);
    await h.settle();
    h.db.files.clear();
    await h.emit(progress(1, 10));
    expect(h.file(1)).toMatchObject({ bytesDone: 10, bytesTotal: 100, state: 'downloading' });
    expect(h.db.files.get(1)?.bytes_done).toBeUndefined(); // ещё не писали: `begin` только что сохранил состояние
    vi.setSystemTime(Date.now() + PERSIST_PROGRESS_MS);
    await h.emit(progress(1, 20));
    expect(h.db.files.get(1)).toMatchObject({ bytes_done: 20, etag: '"e"', resumable: true });
    await h.emit(progress(1, 30));
    expect(h.db.files.get(1)?.bytes_done).toBe(20);
  });

  it('done: запись завершена, место пересчитано, очередь идёт дальше; чужие и устаревшие сообщения игнорируются', async () => {
    const h = offlineHarness({ settings: { concurrency: 1 } });
    await h.start();
    await h.manager.pin('track', 1);
    await h.settle();
    h.storage.files.set('1', 100);
    await h.emit(done(99)); // трека нет
    await h.emit(done(1));
    expect(h.db.files.get(1)).toMatchObject({ attempts: 0, bytes_done: 100, completed_at: Date.now(), state: 'done' });
    expect(h.status.getState().usage.bytes).toBe(100);
    await h.emit(done(1)); // повтор после завершения — игнорируется
    expect(h.file(1)?.state).toBe('done');
  });
});

describe('повторы', () => {
  async function startOne(settings = {}) {
    const h = offlineHarness({ settings: { concurrency: 1, ...settings } });
    await h.start();
    await h.manager.pin('track', 1);
    await h.settle();
    return h;
  }

  it('расписание пауз 5 с → 30 с → 2 мин → 10 мин → 1 ч → 1 ч; 8 попыток — failed', async () => {
    const h = await startOne();
    const delays: number[] = [];
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const before = h.downloader.started.length;
      await h.emit(error(1));
      const next = h.db.files.get(1)!.next_attempt_at!;
      delays.push(next - Date.now());
      expect(h.state(1)).toBe('queued');
      await vi.advanceTimersByTimeAsync(next - Date.now() - 1);
      expect(h.downloader.started).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.downloader.started).toHaveLength(before + 1);
    }
    expect(delays).toEqual([...RETRY_DELAYS_MS, 3_600_000, 3_600_000]);
    await h.emit(error(1));
    expect(h.state(1)).toBe('failed');
    expect(h.file(1)?.error).toBe('network');
    const count = h.downloader.started.length;
    await vi.advanceTimersByTimeAsync(10 * 3_600_000);
    expect(h.downloader.started).toHaveLength(count);
  });

  it('докачка с места обрыва, если ресурс докачиваемый; иначе — с нуля', async () => {
    const h = await startOne();
    await h.emit(progress(1, 40, 100, true));
    await h.emit(error(1, { bytesDone: 55 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.downloader.started[1]).toMatchObject({ etag: '"e"', offset: 55 });

    const g = await startOne();
    await g.emit(progress(1, 40, null, false));
    await g.emit(error(1, { bytesDone: 55 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(g.downloader.started[1]).toMatchObject({ etag: null, offset: 0 });
  });

  it('обрыв до первого прогресса: сведения о файле из ошибки позволяют докачать с места обрыва', async () => {
    const h = await startOne();
    await h.emit({
      ...error(1, { bytesDone: 30 }),
      info: { bytesDone: 30, bytesTotal: 100, etag: '"v"', mime: 'audio/mpeg', resumable: true },
    } as DownloadMessage);
    expect(h.db.files.get(1)).toMatchObject({
      bytes_done: 30,
      bytes_total: 100,
      etag: '"v"',
      mime: 'audio/mpeg',
      resumable: true,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.downloader.started[1]).toMatchObject({ etag: '"v"', offset: 30 });
  });

  it('ручной retry возвращает failed в очередь с нулём попыток', async () => {
    const h = await startOne();
    await h.emit(error(1, { code: 'not_found', retryable: false }));
    expect(h.file(1)).toMatchObject({ error: 'not_found', state: 'failed' });
    h.manager.retry(2); // нет такого трека
    h.manager.retry(1);
    await h.settle();
    expect(h.state(1)).toBe('downloading');
    expect(h.db.files.get(1)?.attempts).toBe(0);
    h.manager.retry(1); // уже качается — не failed
    expect(h.downloader.started).toHaveLength(2);
  });

  it('неповторяемая ошибка (403) — сразу failed', async () => {
    const h = await startOne();
    await h.emit(error(1, { code: 'http_status', retryable: false }));
    expect(h.state(1)).toBe('failed');
  });

  it('QuotaExceededError останавливает очередь до смены лимита или освобождения места', async () => {
    const h = await startOne({ concurrency: 2 });
    await h.manager.pin('track', 2);
    await h.settle();
    await h.emit(error(1, { bytesDone: 7, code: 'quota', retryable: false }));
    expect(h.state(1)).toBe('queued');
    expect(h.status.getState().blocked).toBe('quota');
    expect(h.downloader.startedIds).toEqual([1, 2]);
    h.settings.update({ limitBytes: 10 ** 12 });
    await h.settle();
    expect(h.status.getState().blocked).toBe('none');
    expect(h.downloader.startedIds).toEqual([1, 2, 1]);
  });

  it('401: очередь стоит и не долбит сервер при каждом изменении сети; обработчик потери входа вызван один раз', async () => {
    const h = await startOne();
    await h.emit(error(1, { code: 'unauthorized', retryable: false }));
    expect(h.onUnauthorized).toHaveBeenCalledOnce();
    expect(h.state(1)).toBe('queued');
    expect(h.status.getState().blocked).toBe('unauthorized');
    for (let i = 0; i < 3; i++) h.net.change({ online: i % 2 === 0 });
    h.manager.setPaused(false);
    await h.settle();
    expect(h.downloader.started).toHaveLength(1);
    expect(h.onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe('условия работы очереди', () => {
  it('нет связи — очередь стоит; появилась — продолжает', async () => {
    const h = offlineHarness();
    h.net.online = false;
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    expect(h.downloader.started).toEqual([]);
    expect(h.status.getState()).toMatchObject({ blocked: 'offline', queueLength: 3 });
    h.net.change({ online: true });
    await h.settle();
    expect(h.downloader.startedIds).toEqual([1, 2, 3]);
    expect(h.status.getState().blocked).toBe('none');
  });

  it('пауза: новые загрузки не стартуют; снятие паузы продолжает', async () => {
    const h = offlineHarness();
    await h.start();
    h.manager.setPaused(true);
    await h.manager.pin('track', 1);
    await h.settle();
    expect(h.downloader.started).toEqual([]);
    expect(h.status.getState()).toMatchObject({ blocked: 'paused', paused: true });
    h.manager.setPaused(false);
    expect(h.downloader.startedIds).toEqual([1]);
  });

  it('«только Wi-Fi»: по сотовой сети стоит, по Wi-Fi идёт; выключенная настройка не мешает', async () => {
    const h = offlineHarness({ settings: { wifiOnly: true } });
    h.net.cellular = true;
    await h.start();
    await h.manager.pin('track', 1);
    await h.settle();
    expect(h.status.getState().blocked).toBe('wifi');
    expect(h.downloader.started).toEqual([]);
    h.net.change({ cellular: false });
    await h.settle();
    expect(h.downloader.startedIds).toEqual([1]);
    const g = offlineHarness();
    g.net.cellular = true;
    await g.start();
    await g.manager.pin('track', 1);
    await g.settle();
    expect(g.downloader.startedIds).toEqual([1]);
  });

  it('лимит места: очередь останавливается с quota; после увеличения лимита продолжает', async () => {
    const h = offlineHarness({ settings: { limitBytes: ESTIMATED_TRACK_BYTES * 2 + 5 } });
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    // Два трека по оценке 15 МБ помещаются, третий — нет.
    expect(h.downloader.startedIds).toEqual([1, 2]);
    expect(h.status.getState().blocked).toBe('quota');
    expect(h.status.getState().usage.limit).toBe(ESTIMATED_TRACK_BYTES * 2 + 5);
    h.settings.update({ limitBytes: ESTIMATED_TRACK_BYTES * 10 });
    await h.settle();
    expect(h.downloader.startedIds).toEqual([1, 2, 3]);
    expect(h.status.getState().blocked).toBe('none');
  });

  it('занятое место — из хранилища (с чужими байтами); неизвестный размер оценивается в 15 МБ', async () => {
    const h = offlineHarness({
      files: [offlineFile(1, { bytes_done: 40, bytes_total: 40, state: 'done' })],
      pins: [{ created_at: 1, id: 1, key: 'track:1', kind: 'track' }],
      settings: { limitBytes: 100 },
      storage: { '1': 40 },
    });
    h.storage.extra = 30;
    await h.start();
    expect(h.status.getState().usage).toMatchObject({ bytes: 70, limit: 100 });
    await h.manager.pin('track', 3);
    await h.settle();
    expect(h.status.getState().blocked).toBe('quota');
    expect(h.downloader.started).toEqual([]);
  });

  it('известный размер учитывается точнее оценки: 70 + 20 ≤ 100 — трек качается', async () => {
    const h = offlineHarness({
      files: [offlineFile(2, { bytes_total: 20 })],
      pins: [{ created_at: 1, id: 2, key: 'track:2', kind: 'track' }],
      settings: { limitBytes: 100 },
    });
    h.storage.extra = 70;
    await h.start();
    expect(h.downloader.startedIds).toEqual([2]);
  });

  it('снятие закрепления освобождает место: очередь, стоявшая из-за лимита, идёт дальше', async () => {
    const h = offlineHarness({
      files: [offlineFile(1, { bytes_done: ESTIMATED_TRACK_BYTES, bytes_total: ESTIMATED_TRACK_BYTES, state: 'done' })],
      pins: [{ created_at: 1, id: 1, key: 'track:1', kind: 'track' }],
      settings: { limitBytes: ESTIMATED_TRACK_BYTES + 100 },
      storage: { '1': ESTIMATED_TRACK_BYTES },
    });
    await h.start();
    await h.manager.pin('track', 2);
    await h.settle();
    expect(h.status.getState().blocked).toBe('quota');
    expect(h.downloader.started).toEqual([]);
    await h.manager.unpin('track', 1);
    await h.settle();
    expect(h.status.getState().blocked).toBe('none');
    expect(h.downloader.startedIds).toEqual([2]);
  });

  it('удаление файла освобождает место и снимает остановку по квоте', async () => {
    const h = offlineHarness({ settings: { limitBytes: ESTIMATED_TRACK_BYTES + 1 } });
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    expect(h.status.getState().blocked).toBe('quota');
    await h.manager.unpin('album', 1);
    await h.settle();
    expect(h.status.getState()).toMatchObject({ activeCount: 0, blocked: 'none' });
  });
});

describe('целостность при старте', () => {
  it('запись done, а файла нет или размер не совпал — снова в очереди', async () => {
    const h = offlineHarness({
      files: [
        offlineFile(1, { bytes_done: 100, state: 'done' }),
        offlineFile(2, { bytes_done: 100, state: 'done' }),
        offlineFile(3, { bytes_done: 100, state: 'done' }),
      ],
      pins: [{ created_at: 1, id: 1, key: 'album:1', kind: 'album' }],
      settings: { concurrency: 1 },
      storage: { '2': 60, '3': 100 },
    });
    await h.start();
    expect(h.state(3)).toBe('done');
    expect(h.file(1)).toMatchObject({ bytesDone: 0, state: 'downloading' });
    expect(h.file(2)).toMatchObject({ bytesDone: 0, state: 'queued' });
    expect(h.db.files.get(2)?.completed_at).toBeNull();
  });

  it('система очистила хранилище: у «готовых» файлов нет на диске → onStorageCleared с числом потерянных', async () => {
    const onStorageCleared = vi.fn();
    const h = offlineHarness({
      deps: { onStorageCleared },
      files: [
        offlineFile(1, { bytes_done: 100, state: 'done' }),
        offlineFile(2, { bytes_done: 100, state: 'done' }),
        offlineFile(3, { bytes_done: 100, state: 'done' }),
      ],
      pins: [{ created_at: 1, id: 1, key: 'album:1', kind: 'album' }],
      storage: { '3': 100 },
    });
    await h.start();
    expect(onStorageCleared).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('ничего не потеряно — onStorageCleared не вызывается; частичный размер — не «очистка системой»', async () => {
    const onStorageCleared = vi.fn();
    const h = offlineHarness({
      deps: { onStorageCleared },
      files: [offlineFile(1, { bytes_done: 100, state: 'done' }), offlineFile(2, { bytes_done: 100, state: 'done' })],
      pins: [{ created_at: 1, id: 1, key: 'album:1', kind: 'album' }],
      storage: { '1': 100, '2': 60 },
    });
    await h.start();
    expect(onStorageCleared).not.toHaveBeenCalled();
  });

  it('flush записывает состояние всех файлов в базу сразу', async () => {
    const h = offlineHarness({
      files: [offlineFile(1, { bytes_done: 100, state: 'done' })],
      pins: [{ created_at: 1, id: 1, key: 'album:1', kind: 'album' }],
      storage: { '1': 100 },
    });
    await h.start();
    h.db.files.clear();
    await h.manager.flush();
    expect(h.db.files.get(1)).toMatchObject({ state: 'done' });
  });

  it('файл есть, записи нет — файл удаляется', async () => {
    const h = offlineHarness({ storage: { '42': 10, orphan: 1 } });
    await h.start();
    expect(h.storage.removed.sort()).toEqual(['42', 'orphan']);
  });

  it('запись downloading — в очередь; bytes_done сохраняется только для докачиваемого файла нужного размера', async () => {
    const pins = [{ created_at: 1, id: 1, key: 'album:1', kind: 'album' as const }];
    const h = offlineHarness({
      files: [
        offlineFile(1, { bytes_done: 50, resumable: true, state: 'downloading' }),
        offlineFile(2, { bytes_done: 50, resumable: false, state: 'downloading' }),
        offlineFile(3, { bytes_done: 50, resumable: true, state: 'downloading' }),
      ],
      pins,
      settings: { concurrency: 1, limitBytes: 10 ** 12 },
      storage: { '1': 80, '2': 80 },
    });
    await h.start();
    // Трек 1 стартует с места обрыва; 2 — не докачиваемый, 3 — файла нет: с нуля.
    expect(h.downloader.started[0]).toMatchObject({ offset: 50, trackId: '1' });
    expect(h.db.files.get(2)).toMatchObject({ bytes_done: 0, state: 'queued' });
    expect(h.db.files.get(3)).toMatchObject({ bytes_done: 0, state: 'queued' });
  });

  it('фоновый загрузчик: загрузка, завершённая пока приложение было закрыто, становится done без перекачки', async () => {
    const h = offlineHarness({
      background: true,
      files: [
        offlineFile(1, { bytes_done: 10, bytes_total: 100, resumable: true, state: 'downloading' }),
        offlineFile(2, { bytes_done: 10, bytes_total: 100, resumable: true, state: 'downloading' }),
      ],
      pins: [{ created_at: 1, id: 1, key: 'album:1', kind: 'album' }],
      storage: { '1': 100, '2': 50 },
    });
    await h.start();
    expect(h.state(1)).toBe('done');
    expect(h.db.files.get(1)).toMatchObject({ bytes_done: 100, state: 'done' });
    // Вторую продолжает ОС: менеджер не запускает её заново, а ждёт сообщений.
    expect(h.state(2)).toBe('downloading');
    expect(h.downloader.startedIds).toEqual([3]);
    await h.emit(done(2));
    expect(h.state(2)).toBe('done');
  });
});

describe('вкладки', () => {
  it('не лидер: закрепление пишется в IndexedDB и сообщается лидеру, но не качается; состояние приходит от лидера', async () => {
    const h = offlineHarness({ tabsAuto: false });
    await h.start();
    await h.manager.pin('track', 1);
    expect(h.db.pins.has('track:1')).toBe(true);
    expect(h.status.getState().pins).toEqual(new Set(['track:1']));
    expect(h.tabs.posted).toEqual([{ type: 'pins' }]);
    await h.manager.unpin('track', 1);
    expect(h.tabs.posted).toEqual([{ type: 'pins' }, { type: 'pins' }]);
    expect(h.downloader.started).toEqual([]);
    // Команды уходят лидеру.
    h.manager.retry(5);
    h.manager.setPaused(true);
    void h.manager.markBroken(5);
    void h.manager.markStale([5, 6]);
    await h.manager.removeAll();
    expect(h.tabs.posted.slice(2)).toEqual([
      { trackId: 5, type: 'retry' },
      { type: 'paused', value: true },
      { trackId: 5, type: 'broken' },
      { trackIds: [5, 6], type: 'stale' },
      { type: 'removeAll' },
    ]);
    // Снимок лидера заменяет состояние; чужие команды не лидером игнорируются.
    h.tabs.deliver({
      snapshot: {
        activeCount: 1,
        blocked: 'none',
        files: [[7, { bytesDone: 1, bytesTotal: 2, error: null, mime: 'a', state: 'downloading' }]],
        paused: false,
        pinTimes: { 'album:1': 5 },
        pins: ['album:1'],
        queueLength: 0,
        usage: { bytes: 1, limit: 2, quota: null },
      },
      type: 'status',
    });
    expect(h.status.getState()).toMatchObject({
      activeCount: 1,
      pinTimes: { 'album:1': 5 },
      pins: new Set(['album:1']),
    });
    expect(h.state(7)).toBe('downloading');
    h.tabs.deliver({ type: 'pins' });
    await h.settle();
    expect(h.downloader.started).toEqual([]);
  });

  it('вкладка стала лидером позже: берёт закрепления из IndexedDB и начинает качать', async () => {
    const h = offlineHarness({ tabsAuto: false });
    await h.start();
    await h.manager.pin('track', 2);
    h.tabs.becomeLeader();
    await h.settle();
    expect(h.downloader.startedIds).toEqual([2]);
  });

  it('лидер: перечитывает закрепления по сообщению вкладки и выполняет её команды', async () => {
    const h = offlineHarness();
    await h.start();
    h.db.pins.set('track:2', { created_at: 5, id: 2, key: 'track:2', kind: 'track' });
    h.tabs.deliver({ type: 'pins' });
    await h.settle();
    expect(h.downloader.startedIds).toEqual([2]);
    await h.emit(error(2, { code: 'not_found', retryable: false }));
    h.tabs.deliver({ trackId: 2, type: 'retry' });
    expect(h.state(2)).toBe('downloading');
    h.tabs.deliver({ type: 'paused', value: true });
    expect(h.status.getState().paused).toBe(true);
    h.tabs.deliver({ trackId: 2, type: 'broken' });
    await h.settle();
    expect(h.file(2)).toMatchObject({ error: 'corrupt', state: 'queued' });
    h.tabs.deliver({ trackIds: [2], type: 'stale' });
    await h.settle();
    expect(h.file(2)).toMatchObject({ error: null, state: 'queued' });
    h.tabs.deliver({ type: 'removeAll' });
    await h.settle();
    expect(h.status.getState().files.size).toBe(0);
    // Собственный снимок лидер не применяет к себе.
    h.tabs.deliver({
      snapshot: {
        activeCount: 9,
        blocked: 'none',
        files: [],
        paused: false,
        pinTimes: {},
        pins: [],
        queueLength: 0,
        usage: { bytes: 0, limit: 0, quota: null },
      },
      type: 'status',
    });
    expect(h.status.getState().activeCount).toBe(0);
  });

  it('лидер публикует состояние остальным вкладкам — не чаще раза в 500 мс', async () => {
    const h = offlineHarness();
    await h.start();
    h.tabs.posted.length = 0;
    await h.manager.pin('track', 1);
    await h.settle();
    await h.emit(progress(1, 10));
    expect(h.tabs.posted).toEqual([]);
    await vi.advanceTimersByTimeAsync(STATUS_BROADCAST_MS);
    expect(h.tabs.posted).toHaveLength(1);
    const msg = h.tabs.posted[0]!;
    expect(msg.type === 'status' && msg.snapshot.files[0]).toEqual([1, expect.objectContaining({ bytesDone: 10 })]);
  });
});

describe('удаление занятого файла', () => {
  it('файл удаляется только после того, как загрузчик подтвердил освобождение', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('track', 1);
    await h.settle();
    let release: () => void = () => undefined;
    h.downloader.abort = () => new Promise<void>(resolve => (release = resolve));
    let unpinned = false;
    void h.manager.unpin('track', 1).then(() => (unpinned = true));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.storage.removed).toEqual([]); // воркер ещё держит файл
    release();
    await h.settle();
    expect(h.storage.removed).toEqual(['1']);
    expect(unpinned).toBe(true);
    expect(h.db.files.has(1)).toBe(false);
  });

  it('clear при идущих загрузках ждёт воркера и стирает всё', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    h.storage.files.set('1', 3);
    const releases: (() => void)[] = [];
    h.downloader.abort = () => new Promise<void>(resolve => releases.push(resolve));
    const cleared = h.manager.clear();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.storage.removed).toEqual([]);
    releases.forEach(r => r());
    await cleared;
    expect(h.storage.files.size).toBe(0);
    expect(h.db.files.size + h.db.pins.size).toBe(0);
  });
});

describe('сбои', () => {
  it('сбой фоновой операции сообщается через onError и не ломает очередь', async () => {
    const onError = vi.fn();
    const h = offlineHarness({ deps: { onError } });
    await h.start();
    const boom = new Error('idb closed');
    h.db.offlineLoad = () => Promise.reject(boom);
    h.tabs.deliver({ type: 'pins' });
    await h.settle();
    expect(onError).toHaveBeenCalledWith(boom);
    // Менеджер жив: закрепление по-прежнему работает.
    await h.manager.pin('track', 1);
    await h.settle();
    expect(h.downloader.startedIds).toEqual([1]);
  });
});

describe('команды и жизненный цикл', () => {
  it('markBroken: файл удалён, запись в очереди, трек перекачивается', async () => {
    const h = offlineHarness({ settings: { concurrency: 1 } });
    await h.start();
    await h.manager.pin('track', 1);
    await h.settle();
    await h.emit(done(1));
    h.storage.files.set('1', 100);
    await h.manager.markBroken(404); // нет такого — ничего не происходит
    await h.manager.markBroken(1);
    await h.settle();
    expect(h.storage.removed).toContain('1');
    expect(h.downloader.startedIds).toEqual([1, 1]);
    expect(h.db.files.get(1)).toMatchObject({ error: 'corrupt', state: 'downloading' });
  });

  it('markStale: устаревшие файлы удалены и скачиваются заново, без пометки об ошибке', async () => {
    const h = offlineHarness({ settings: { concurrency: 2 } });
    await h.start();
    await h.manager.pin('track', 1);
    await h.manager.pin('track', 2);
    await h.settle();
    await h.emit(done(1));
    await h.emit(done(2));
    h.storage.files.set('1', 100);
    h.storage.files.set('2', 100);
    await h.manager.markStale([1, 404]); // 404 — нет на устройстве, пропускается
    await h.settle();
    expect(h.storage.removed).toEqual(['1']);
    expect(h.downloader.startedIds).toEqual([1, 2, 1]);
    expect(h.db.files.get(1)).toMatchObject({ error: null, state: 'downloading' });
    expect(h.db.files.get(2)).toMatchObject({ state: 'done' });
    await h.manager.markStale([]); // пусто — ничего
    await h.settle();
    expect(h.downloader.startedIds).toEqual([1, 2, 1]);
  });

  it('markStale прерывает идущую загрузку', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('track', 1);
    await h.settle();
    await h.manager.markStale([1]);
    expect(h.downloader.aborted).toContain('1');
  });

  it('markBroken прерывает идущую загрузку', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('track', 1);
    await h.settle();
    await h.manager.markBroken(1);
    expect(h.downloader.aborted).toContain('1');
  });

  it('removeAll снимает закрепления и удаляет файлы, прерывая загрузки', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    h.storage.files.set('1', 1);
    await h.manager.removeAll();
    expect(h.downloader.aborted.sort()).toEqual(['1', '2', '3']);
    expect(h.status.getState()).toMatchObject({ activeCount: 0, queueLength: 0 });
    expect(h.status.getState().pins.size).toBe(0);
    expect(h.db.pins.size + h.db.files.size).toBe(0);
    expect(h.storage.files.size).toBe(0);
  });

  it('clear (выход): файлы, записи и закрепления удалены, состояние сброшено, вкладки отключены', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('album', 1);
    await h.settle();
    await h.manager.clear();
    expect(h.db.pins.size + h.db.files.size).toBe(0);
    expect(h.status.getState()).toMatchObject({ activeCount: 0, supported: true });
    expect(h.status.getState().files.size).toBe(0);
    expect(h.tabs.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.tabs.posted.filter(m => m.type === 'status')).toEqual([]);
  });

  it('stop прерывает загрузки (записи остаются), отписывается и игнорирует последующие сообщения', async () => {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('track', 1);
    await h.settle();
    h.manager.stop();
    expect(h.downloader.aborted).toEqual(['1']);
    await h.emit(done(1));
    expect(h.db.files.get(1)?.state).toBe('downloading');
    h.library.getState().patchTrack(1, { title: 'x' });
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS);
    expect(h.downloader.started).toHaveLength(1);
  });

  it('перезапуск: закрепления и скачанное сохраняются между запусками', async () => {
    const a = offlineHarness();
    await a.start();
    await a.manager.pin('track', 1);
    await a.settle();
    await a.emit(done(1));
    a.storage.files.set('1', 100);
    a.manager.stop();
    const b = offlineHarness({ files: [...a.db.files.values()], pins: [...a.db.pins.values()], storage: { '1': 100 } });
    await b.start();
    expect(b.state(1)).toBe('done');
    expect(b.downloader.started).toEqual([]);
    expect(b.manager.isPinned('track', 1)).toBe(true);
  });
});

describe('состояние для интерфейса', () => {
  it('трек, альбом и плейлист: none / partial / queued / downloading / done / failed', async () => {
    const h = offlineHarness({ settings: { concurrency: 1 } });
    await h.start();
    const s = () => h.status.getState();
    const lib = () => h.library.getState();
    expect(trackOfflineState(s(), 1)).toEqual({ kind: 'none' });
    await h.manager.pin('album', 1);
    await h.settle();
    expect(trackOfflineState(s(), 1)).toEqual({ kind: 'downloading', progress: 0 });
    expect(trackOfflineState(s(), 2)).toEqual({ kind: 'queued' });
    await h.emit(progress(1, 25, 100));
    expect(albumOfflineState(s(), lib(), 1)).toEqual({ kind: 'downloading', progress: 0.25 / 3 });
    await h.emit(done(1));
    await h.emit(error(2, { code: 'not_found', retryable: false }));
    await h.emit(done(3));
    expect(albumOfflineState(s(), lib(), 1)).toEqual({ kind: 'partial' });
    expect(trackOfflineState(s(), 2)).toEqual({ kind: 'failed' });
    expect(albumOfflineState(s(), lib(), 2)).toEqual({ kind: 'none' });
    expect(playlistOfflineState(s(), lib(), 1)).toEqual({ kind: 'partial' }); // трек 2 — failed, у трека 4 записи нет
  });

  it('все треки скачаны — done; без треков — none', async () => {
    const h = offlineHarness({ settings: { concurrency: 6 } });
    await h.start();
    await h.manager.pin('playlist', 1);
    await h.settle();
    await h.emit(done(2));
    await h.emit(done(4));
    const s = h.status.getState();
    expect(playlistOfflineState(s, h.library.getState(), 1)).toEqual({ kind: 'done' });
    expect(playlistOfflineState(s, h.library.getState(), 404)).toEqual({ kind: 'none' });
  });
});

describe('публикация состояния без лишних изменений', () => {
  async function twoDownloading() {
    const h = offlineHarness();
    await h.start();
    await h.manager.pin('track', 1);
    await h.manager.pin('track', 2);
    await h.settle();
    return h;
  }
  const updates = (h: Awaited<ReturnType<typeof twoDownloading>>) => {
    const n = { count: 0 };
    h.status.subscribe(() => n.count++);
    return n;
  };

  it('progress keeps unrelated file statuses referentially equal', async () => {
    const h = await twoDownloading();
    const before = h.status.getState();
    const other = before.files.get(2);
    await h.emit(progress(1, 10));
    const after = h.status.getState();
    expect(after.files.get(1)?.bytesDone).toBe(10);
    expect(after.files.get(2)).toBe(other);
    expect(after.pins).toBe(before.pins);
    expect(after.pinTimes).toBe(before.pinTimes);
  });

  it('progress publishes are throttled', async () => {
    const h = await twoDownloading();
    await vi.advanceTimersByTimeAsync(PROGRESS_PUBLISH_MS); // окно прошлых публикаций закрыто
    const n = updates(h);
    for (let i = 1; i <= 20; i++) {
      await h.emit(progress(1, i));
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(n.count).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(PROGRESS_PUBLISH_MS);
    expect(h.file(1)?.bytesDone).toBe(20);
    expect(n.count).toBeLessThanOrEqual(3);
  });

  it('state changes publish immediately', async () => {
    const h = await twoDownloading();
    await h.emit(progress(1, 10));
    await h.emit(progress(1, 20)); // внутри окна: ждёт таймера
    expect(h.file(1)?.bytesDone).toBe(10);
    await h.emit(done(1));
    expect(h.state(1)).toBe('done');
    expect(h.file(1)?.bytesDone).toBe(100);
  });

  it('doneRevision changes only when the done set changes', async () => {
    const h = await twoDownloading();
    const rev = () => h.status.getState().doneRevision;
    const r0 = rev();
    await h.emit(progress(1, 10));
    await vi.advanceTimersByTimeAsync(PROGRESS_PUBLISH_MS);
    expect(rev()).toBe(r0);
    await h.emit(done(1));
    const r1 = rev();
    expect(r1).toBeGreaterThan(r0);
    await h.emit(progress(2, 10));
    await vi.advanceTimersByTimeAsync(PROGRESS_PUBLISH_MS);
    expect(rev()).toBe(r1);
    await h.manager.markBroken(1); // скачанный файл вернулся в очередь
    expect(rev()).toBeGreaterThan(r1);
    const r2 = rev();
    await h.emit(done(1));
    const r3 = rev();
    expect(r3).toBeGreaterThan(r2);
    await h.manager.unpin('track', 1); // скачанный файл удалён
    await h.settle();
    expect(rev()).toBeGreaterThan(r3);
  });

  it('no setState when nothing changed', async () => {
    const h = await twoDownloading();
    const n = updates(h);
    h.manager.setPaused(false); // пересчёт очереди без изменений
    await h.settle();
    expect(n.count).toBe(0);
  });

  it('снимок без doneRevision (старая вкладка) считается сменой набора скачанного', async () => {
    const { fromSnapshot, toSnapshot, initialOfflineStatus } = await import('./status');
    const snap = toSnapshot(initialOfflineStatus());
    const old = { ...snap, doneRevision: undefined };
    expect(fromSnapshot(old, 4).doneRevision).toBe(5);
    expect(fromSnapshot({ ...snap, doneRevision: 9 }, 4).doneRevision).toBe(9);
  });

  it('stop снимает таймер публикации прогресса', async () => {
    const h = await twoDownloading();
    await h.emit(progress(1, 10));
    await h.emit(progress(1, 20));
    h.manager.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
