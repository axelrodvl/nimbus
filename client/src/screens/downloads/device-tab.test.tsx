import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api/acquisition';
import { resetAppData } from '@/lib/app-data';
import { installOffline } from '@/lib/offline';
import { makeAlbum, makeArtist, makePlaylist, makePlaylistTrack, makeTrack, resetFactories } from '@/test/factories';
import { mockLayout, ScrollHost } from '@/test/layout';
import { fileStatus, installOfflineUi, type OfflineUi } from '@/test/offline-ui';
import { renderRoutes } from '@/test/render';
import { seed } from '@/test/seed';
import { item, page, summary } from '@/test/acquisition';
import { DownloadsScreen } from './downloads-screen';

vi.mock('@/lib/api/settings', () => ({
  fetchStorage: vi.fn(async () => ({
    files: 0,
    limit_bytes: 1,
    over_limit: false,
    pinned_bytes: 0,
    pinned_files: 0,
    torrents_active: 0,
    used_bytes: 0,
  })),
  loadPrefetchEnabled: async () => true,
}));
vi.mock('@/lib/api/acquisition', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  getAcquisitionSummary: vi.fn(),
  getDownloads: vi.fn(),
  getFailedJobs: vi.fn(),
  listAcquisition: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const MB = 1024 ** 2;
const GB = 1024 ** 3;

let ui: OfflineUi;
let restore: () => void;
beforeEach(() => {
  resetFactories();
  restore = mockLayout({ height: 2000, width: 1000 });
  vi.mocked(api.getAcquisitionSummary).mockResolvedValue(summary({ missing: 2 }));
  vi.mocked(api.listAcquisition).mockResolvedValue(page([item(1)]));
  vi.mocked(api.getDownloads).mockResolvedValue({ paused: false, torrents: [] } as never);
  vi.mocked(api.getFailedJobs).mockResolvedValue({ counts: { failed: 0, queued: 0, running: 0 }, jobs: [] });
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 1, title: 'Big' }), makeAlbum({ artist_id: 1, id: 2, title: 'Small' })],
    artists: [makeArtist({ id: 1 })],
    playlistTracks: [makePlaylistTrack({ id: 1, playlist_id: 5, track_id: 3 })],
    playlists: [makePlaylist({ id: 5, name: 'Mix' })],
    tracks: [
      makeTrack({ album_id: 1, id: 1, position: 1, title: 'B1' }),
      makeTrack({ album_id: 1, id: 2, position: 2, title: 'B2' }),
      makeTrack({ album_id: 2, id: 3, position: 1, title: 'S1' }),
    ],
  });
  ui = installOfflineUi();
});
afterEach(async () => {
  restore();
  installOffline(null);
  await resetAppData(true);
});

const routes = [
  {
    element: (
      <ScrollHost>
        <DownloadsScreen />
      </ScrollHost>
    ),
    path: '/downloads/:tab?',
  },
];
const open = (path = '/downloads/device') => renderRoutes(routes, path);

const usage = (bytes: number, limit = 10 * GB, quota: number | null = 100 * GB) => ({ usage: { bytes, limit, quota } });

describe('раздел «На этом устройстве»', () => {
  it('отдельная группа «Это устройство» в конце списка; серверные действия скрыты; счётчик — активные и ожидающие', async () => {
    open('/downloads/attention');
    const link = await screen.findByTestId('acq-tab-link-device');
    expect(link).toHaveTextContent('На этом устройстве');
    const groups = within(screen.getByTestId('acq-nav')).getAllByRole('region');
    expect(groups.at(-1)).toHaveTextContent('Это устройство');
    expect(within(groups.at(-1) as HTMLElement).getByRole('link')).toBe(link);
    expect(link).not.toHaveTextContent(/\d/);
    ui.set({ 1: fileStatus('queued') }, { activeCount: 1, queueLength: 40 });
    expect(link).toHaveTextContent('41');
    await userEvent.click(link);
    expect(await screen.findByTestId('device-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('pause-all')).toBeNull();
    expect(screen.queryByTestId('download-all')).toBeNull();
  });

  it('без поддержки раздела нет, адрес — «не найдено»', async () => {
    installOfflineUi({ supported: false });
    open('/downloads/attention');
    await screen.findByTestId('acq-tab-attention');
    expect(screen.queryByTestId('acq-tab-link-device')).toBeNull();
    const second = open('/downloads/device');
    expect(second.container.querySelector('[data-testid="device-tab"]')).toBeNull();
  });

  it('без связи открывается по умолчанию', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    open('/downloads');
    expect(await screen.findByTestId('device-tab')).toBeInTheDocument();
    expect(screen.getByTestId('acq-section')).toHaveTextContent('На этом устройстве');
  });

  it('в списке разделов у группы «Это устройство» — занято и свободно; без лимита шкалы нет', () => {
    open('/downloads/attention');
    expect(screen.queryByTestId('acq-space-device')).toBeNull();
    ui.set({}, usage(9.5 * GB));
    const meter = screen.getByTestId('acq-space-device');
    expect(meter).toHaveTextContent('Занято 9.5 ГБ из 10 ГБ');
    expect(meter).toHaveTextContent('свободно 512 МБ');
    expect(within(meter).getByRole('progressbar', { name: 'Место под офлайн-музыку на устройстве' })).toHaveAttribute(
      'aria-valuenow',
      String(9.5 * GB),
    );
  });

  it('сводка: занято / лимит / квота, число треков', () => {
    open();
    ui.set({ 1: fileStatus('done', 5 * MB, 5 * MB), 2: fileStatus('done', 5 * MB, 5 * MB) }, usage(2 * GB));
    expect(screen.getByTestId('device-usage')).toHaveTextContent(
      'Занято 2.0 ГБ из 10 ГБ · квота браузера 100 ГБ · 2 трека',
    );
    const bar = screen.getByRole('progressbar', { name: 'Занято на этом устройстве' });
    expect(bar).toHaveAttribute('aria-valuenow', String(2 * GB));
  });

  const QUEUE: [Record<string, unknown>, string, string][] = [
    [{ activeCount: 3, queueLength: 41 }, 'active', 'Скачивается 3, в очереди 41'],
    [{ blocked: 'paused', paused: true }, 'paused', 'Пауза'],
    [{ blocked: 'quota', queueLength: 2 }, 'quota', 'Нет места — освободите место или увеличьте лимит'],
    [{ blocked: 'offline', queueLength: 2 }, 'offline', 'Нет связи — загрузка продолжится позже'],
    [{ blocked: 'wifi', queueLength: 2 }, 'wifi', 'Только по Wi-Fi — ждём подключения'],
    [{ blocked: 'unauthorized', queueLength: 2 }, 'unauthorized', 'Нужно войти снова'],
    [{}, 'idle', 'Очередь пуста'],
  ];
  it.each(QUEUE)('состояние очереди %j — своим текстом', (extra, key, text) => {
    open();
    ui.set({}, extra);
    const el = screen.getByTestId('device-queue');
    expect(el).toHaveAttribute('data-queue', key);
    expect(el).toHaveTextContent(text);
  });

  it('есть неудавшиеся: текст и кнопка «Повторить неудавшиеся»', async () => {
    open();
    expect(screen.getByTestId('device-retry')).toBeDisabled();
    ui.set({ 1: fileStatus('failed'), 2: fileStatus('done', 1, 1), 3: fileStatus('failed') });
    expect(screen.getByTestId('device-queue')).toHaveTextContent('Не скачалось: 2');
    await userEvent.click(screen.getByTestId('device-retry'));
    expect(ui.manager.retry.mock.calls).toEqual([[1], [3]]);
  });

  it('«Пауза» и «Продолжить» переключают очередь', async () => {
    open();
    await userEvent.click(screen.getByTestId('device-pause'));
    expect(ui.manager.setPaused).toHaveBeenLastCalledWith(true);
    ui.set({}, { blocked: 'paused', paused: true });
    expect(screen.getByTestId('device-pause')).toHaveTextContent('Продолжить');
    await userEvent.click(screen.getByTestId('device-pause'));
    expect(ui.manager.setPaused).toHaveBeenLastCalledWith(false);
  });

  it('активные загрузки с прогрессом; пусто — блока нет', () => {
    open();
    expect(screen.queryByTestId('device-active')).toBeNull();
    ui.set({ 1: fileStatus('downloading', 25, 100), 2: fileStatus('queued') });
    const rows = within(screen.getByTestId('device-active')).getAllByTestId('device-active-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('B1');
    expect(within(rows[0] as HTMLElement).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0.25');
  });

  it('пусто: подсказка', () => {
    open();
    expect(screen.getByText('Пока ничего не скачано')).toBeInTheDocument();
    expect(screen.queryByTestId('device-pins')).toBeNull();
  });

  const withPins = () =>
    ui.set(
      {
        1: fileStatus('done', 5 * MB, 5 * MB),
        2: fileStatus('done', 5 * MB, 5 * MB),
        3: fileStatus('downloading', 1 * MB, 4 * MB),
      },
      {
        pinTimes: { 'album:1': 100, 'playlist:5': 300, 'track:3': 200 },
        pins: new Set(['album:1', 'playlist:5', 'track:3']),
      },
    );
  const titles = () => screen.getAllByTestId('pin-title').map(e => e.textContent);

  it('закрепления: название, «Скачано N из M · размер», ссылки; сортировка по дате и по размеру', async () => {
    open();
    withPins();
    // По дате: новые сверху.
    expect(titles()).toEqual(['Mix', 'S1', 'Big']);
    const rows = screen.getAllByTestId('device-pin');
    expect(within(rows[2] as HTMLElement).getByTestId('pin-meta')).toHaveTextContent('Скачано 2 из 2 · 10 МБ');
    expect(within(rows[2] as HTMLElement).getByRole('link', { name: 'Big' })).toHaveAttribute('href', '/album/1');
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Mix' })).toHaveAttribute('href', '/playlist/5');
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'S1' })).toHaveAttribute('href', '/album/2');
    await userEvent.click(screen.getByRole('radio', { name: 'По размеру' }));
    expect(titles()).toEqual(['Big', 'Mix', 'S1']);
    await userEvent.click(screen.getByRole('radio', { name: 'По дате' }));
    expect(titles()).toEqual(['Mix', 'S1', 'Big']);
  });

  it('«Избранное» и пропавшее из библиотеки закрепление', () => {
    open();
    ui.set({}, { pins: new Set(['playlist:0', 'album:99']) });
    expect(titles().sort()).toEqual(['Любимое', 'Недоступно'].sort());
    expect(screen.getByText('Нет в библиотеке — скоро будет удалено с устройства')).toBeInTheDocument();
  });

  it('удаление закрепления: подтверждение, затем снятие закрепления с треками', async () => {
    open();
    withPins();
    const row = screen.getAllByTestId('device-pin').at(-1) as HTMLElement;
    await userEvent.click(within(row).getByTestId('pin-remove'));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить с устройства' });
    expect(dialog).toHaveTextContent('«Big»');
    expect(ui.manager.unpin).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить с устройства' }));
    await waitFor(() => expect(ui.manager.unpin).toHaveBeenCalledWith('album', 1));
    expect(ui.manager.unpin).toHaveBeenCalledWith('track', 1);
    await waitFor(() => expect(titles()).toEqual(['Mix', 'S1']));
  });

  it('закреплённый трек ведёт на свой альбом; запись без прогресса не рисует полосу', () => {
    open();
    ui.set({ 3: fileStatus('queued') }, { pins: new Set(['track:3']) });
    const row = screen.getByTestId('device-pin');
    expect(within(row).getByRole('link', { name: 'S1' })).toHaveAttribute('href', '/album/2');
    expect(within(row).queryByRole('progressbar')).toBeNull();
    expect(within(row).getByTestId('pin-meta')).toHaveTextContent('В очереди');
    act(() => ui.rt.status.setState({ files: new Map([[3, fileStatus('failed')]]) }));
    expect(within(row).getByTestId('pin-meta')).toHaveTextContent('Не скачалось: 1');
  });
});
