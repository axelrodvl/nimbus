import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppData } from '@/lib/app-data';
import { installOffline } from '@/lib/offline';
import { makeAlbum, makeArtist, makePlaylist, makePlaylistTrack, makeTrack, resetFactories } from '@/test/factories';
import { fileStatus, installOfflineUi, type OfflineUi } from '@/test/offline-ui';
import { seed } from '@/test/seed';
import {
  useAlbumDimmed,
  useAlbumOffline,
  useDownloadedSets,
  useOfflineSupported,
  usePendingCount,
  usePinned,
  usePinSummaries,
  usePlaylistOffline,
  useQueueProgress,
  useTrackOffline,
  useTracksOffline,
} from './hooks';

let ui: OfflineUi;

beforeEach(() => {
  resetFactories();
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 1, title: 'A1' }), makeAlbum({ artist_id: 1, id: 2 })],
    artists: [makeArtist({ id: 1 })],
    playlistTracks: [makePlaylistTrack({ id: 1, playlist_id: 5, track_id: 2 })],
    playlists: [makePlaylist({ id: 5, name: 'P' })],
    tracks: [
      makeTrack({ album_id: 1, id: 1, position: 1, status: 'ready' }),
      makeTrack({ album_id: 1, id: 2, position: 2, status: 'ready' }),
      makeTrack({ album_id: 2, id: 3, position: 1, status: 'ready' }),
    ],
  });
  ui = installOfflineUi();
});

afterEach(async () => {
  installOffline(null);
  await resetAppData(true);
});

describe('сводки', () => {
  it('альбом: состояние и счётчики обновляются вместе с файлами', () => {
    const { result } = renderHook(() => useAlbumOffline(1));
    expect(result.current).toMatchObject({ done: 0, state: { kind: 'none' }, total: 2 });
    ui.set({ 1: fileStatus('done', 10, 10), 2: fileStatus('downloading', 5, 10) });
    expect(result.current).toMatchObject({ bytes: 15, done: 1, state: { kind: 'downloading', progress: 0.75 } });
    ui.set({ 1: fileStatus('done', 10, 10), 2: fileStatus('done', 10, 10) });
    expect(result.current.state).toEqual({ kind: 'done' });
  });

  it('ссылка на сводку стабильна, пока видимое не изменилось (чужие файлы её не трогают)', () => {
    const { result } = renderHook(() => useAlbumOffline(1));
    ui.set({ 1: fileStatus('downloading', 1000, 100000) });
    const first = result.current;
    ui.set({ 1: fileStatus('downloading', 1000, 100000), 3: fileStatus('downloading', 5, 10) });
    expect(result.current).toBe(first);
  });

  it('плейлист и произвольный список', () => {
    ui.set({ 2: fileStatus('done', 1, 1) });
    expect(renderHook(() => usePlaylistOffline(5)).result.current.state).toEqual({ kind: 'done' });
    expect(renderHook(() => useTracksOffline([1, 2, 3])).result.current).toMatchObject({
      done: 1,
      state: { kind: 'partial' },
    });
  });

  it('без поддержки сводка всегда пустая', () => {
    installOfflineUi({ supported: false });
    const { result } = renderHook(() => useAlbumOffline(1));
    expect(result.current.state).toEqual({ kind: 'none' });
    expect(renderHook(() => useOfflineSupported()).result.current).toBe(false);
  });

  it('состояние одного трека: прогресс по процентам', () => {
    const { result } = renderHook(() => useTrackOffline(1));
    expect(result.current).toEqual({ kind: 'none' });
    ui.set({ 1: fileStatus('downloading', 3, 10) });
    expect(result.current).toEqual({ kind: 'downloading', progress: 0.3 });
    ui.set({ 1: fileStatus('done', 10, 10) });
    expect(result.current).toEqual({ kind: 'done' });
  });
});

describe('закрепление', () => {
  it('закреплена сущность или любой её трек по отдельности', () => {
    const { result } = renderHook(() => usePinned('album', 1, [1, 2]));
    expect(result.current).toBe(false);
    act(() => ui.rt.status.setState({ pins: new Set(['track:2']) }));
    expect(result.current).toBe(true);
    act(() => ui.rt.status.setState({ pins: new Set(['album:1']) }));
    expect(result.current).toBe(true);
    // Для трека значение имеет только его собственное закрепление.
    const track = renderHook(() => usePinned('track', 1, [1]));
    expect(track.result.current).toBe(false);
  });

  it('закрепления для вкладки «На устройстве»', () => {
    const { result } = renderHook(() => usePinSummaries());
    expect(result.current).toEqual([]);
    ui.set({ 1: fileStatus('done', 7, 7) }, { pins: new Set(['album:1', 'playlist:0']) });
    expect(result.current.map(p => p.key).sort()).toEqual(['album:1', 'playlist:0']);
    expect(result.current.find(p => p.key === 'album:1')).toMatchObject({ bytes: 7, done: 1, title: 'A1' });
  });
});

describe('очередь', () => {
  it('число ожидающих и общий прогресс пачки', () => {
    const count = renderHook(() => usePendingCount());
    const progress = renderHook(() => useQueueProgress());
    expect(count.result.current).toBe(0);
    expect(progress.result.current).toBeNull();
    ui.set(
      { 1: fileStatus('queued'), 2: fileStatus('downloading', 0, 10), 3: fileStatus('queued') },
      { activeCount: 1, queueLength: 2 },
    );
    expect(count.result.current).toBe(3);
    expect(progress.result.current).toBe(0);
    ui.set(
      { 1: fileStatus('queued'), 2: fileStatus('downloading', 5, 10), 3: fileStatus('done', 1, 1) },
      { activeCount: 1, queueLength: 1 },
    );
    expect(progress.result.current).toBeCloseTo(1 - 1.5 / 3);
    // Очередь опустела: индикатор скрывается, пачка забывается.
    ui.set({ 1: fileStatus('done', 1, 1), 2: fileStatus('done', 1, 1) }, { activeCount: 0, queueLength: 0 });
    expect(progress.result.current).toBeNull();
    ui.set({ 1: fileStatus('queued') }, { activeCount: 0, queueLength: 1 });
    expect(progress.result.current).toBe(0);
  });
});

describe('библиотека', () => {
  it('«только скачанные» вычисляется, лишь когда включено', () => {
    ui.set({ 1: fileStatus('done', 1, 1), 2: fileStatus('done', 1, 1), 3: fileStatus('queued') });
    expect(renderHook(() => useDownloadedSets(false)).result.current).toBeNull();
    const { result } = renderHook(() => useDownloadedSets(true));
    expect([...result.current!.albums]).toEqual([1]);
    expect([...result.current!.tracks].sort()).toEqual([1, 2]);
  });

  it('альбом приглушён без связи, если в нём нечего играть', () => {
    const { result } = renderHook(() => useAlbumDimmed(1));
    expect(result.current).toBe(false);
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    act(() => void globalThis.dispatchEvent(new Event('offline')));
    expect(result.current).toBe(true);
    ui.set({ 1: fileStatus('done', 1, 1) });
    // Статус сети не менялся, но скачанный трек делает альбом доступным.
    expect(renderHook(() => useAlbumDimmed(1)).result.current).toBe(false);
    expect(renderHook(() => useAlbumDimmed(2)).result.current).toBe(true);
  });
});

describe('перерисовки', () => {
  it('useAlbumOffline не перерисовывает компонент при прогрессе трека другого альбома', () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useAlbumOffline(1);
    });
    ui.set({ 1: fileStatus('downloading', 1, 10), 3: fileStatus('downloading', 1, 10) });
    const before = renders;
    for (let i = 2; i <= 9; i++) ui.set({ 1: fileStatus('downloading', 1, 10), 3: fileStatus('downloading', i, 10) });
    expect(renders).toBe(before);
  });
});

