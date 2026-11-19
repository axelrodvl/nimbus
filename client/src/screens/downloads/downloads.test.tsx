import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerDownloadButton } from '@/components/downloads/server-download-button';
import { AlbumHeaderMenu } from '@/components/library/album-menu';
import { MobileTabBar } from '@/components/mobile-tab-bar';
import * as api from '@/lib/api/acquisition';
import { ApiError } from '@/lib/api/errors';
import { appData } from '@/lib/app-data';
import { I18nProvider } from '@/lib/i18n/provider';
import ru from '@/lib/i18n/messages/ru';
import { createI18nStore } from '@/lib/i18n/store';
import { NAV_ITEMS } from '@/lib/nav/items';
import { item, L, page, summary, torrent } from '@/test/acquisition';
import { mockLayout, ScrollHost } from '@/test/layout';
import { renderRoutes } from '@/test/render';
import { JobsSection } from '../settings/jobs-section';
import { DownloadsScreen, LegacyDownloadsRedirect } from './downloads-screen';

vi.mock('@/lib/api/settings', () => ({
  fetchStorage: vi.fn(async () => ({
    files: 3,
    limit_bytes: 50 * 1024 ** 3,
    over_limit: false,
    pinned_bytes: 0,
    pinned_files: 0,
    torrents_active: 0,
    used_bytes: 12 * 1024 ** 3,
  })),
  loadPrefetchEnabled: async () => true,
}));
vi.mock('@/lib/api/acquisition', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  getAcquisitionSummary: vi.fn(),
  getDownloads: vi.fn(),
  getFailedJobs: vi.fn(),
  getJobInvariants: vi.fn(),
  listAcquisition: vi.fn(),
  pinAlbumRequest: vi.fn(),
  retryAcquisitionRequest: vi.fn(),
  retryJobRequest: vi.fn(),
  setPausedAll: vi.fn(),
  setTorrentPaused: vi.fn(),
  unpinAlbumRequest: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const m = {
  downloads: vi.mocked(api.getDownloads),
  invariants: vi.mocked(api.getJobInvariants),
  jobs: vi.mocked(api.getFailedJobs),
  list: vi.mocked(api.listAcquisition),
  pin: vi.mocked(api.pinAlbumRequest),
  pauseAll: vi.mocked(api.setPausedAll),
  pauseOne: vi.mocked(api.setTorrentPaused),
  retry: vi.mocked(api.retryAcquisitionRequest),
  retryJob: vi.mocked(api.retryJobRequest),
  summary: vi.mocked(api.getAcquisitionSummary),
  unpin: vi.mocked(api.unpinAlbumRequest),
};

const pinned = (state: api.PinState, over: Partial<api.AcquisitionDownload> = {}): api.AcquisitionDownload => ({
  bytes_done: 0,
  bytes_total: 0,
  down_bps: 0,
  peers: 0,
  pinned: true,
  state,
  ...over,
});
const overview = (over: Partial<api.DownloadsOverview> = {}): api.DownloadsOverview => ({
  down_bps: 0,
  paused: false,
  queue: { downloading: 0, failed: 0, queued: 0, waiting_source: 0 },
  torrents: [],
  up_bps: 0,
  ...over,
});

/** Ответ списка по состояниям: `byState['missing,partial']` → строки. */
const serve = (byState: Record<string, api.AcquisitionItem[]>) =>
  m.list.mockImplementation(async q => page(byState[(q.states ?? []).join(',')] ?? []));

let restore: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  restore = mockLayout({ height: 2000, width: 1000 });
  m.summary.mockResolvedValue(summary({ missing: 2, available: 1 }));
  m.downloads.mockResolvedValue(overview());
  m.jobs.mockResolvedValue({ counts: { failed: 0, queued: 0, running: 0 }, jobs: [] });
  m.invariants.mockResolvedValue({ checked_at: '2026-11-17T00:00:00Z', grace_secs: 1800, sections: [], total: 0 });
  serve({ 'missing,partial': [item(1), item(2)] });
});
afterEach(() => restore());

const routes = [
  {
    element: (
      <ScrollHost>
        <DownloadsScreen />
      </ScrollHost>
    ),
    path: '/downloads/:tab?',
  },
  { element: <LegacyDownloadsRedirect />, path: '/settings/downloads' },
  { element: <JobsSection />, path: '/settings/jobs' },
  { element: <p data-testid="settings">settings</p>, path: '/settings/:section?' },
];
const open = (path = '/downloads') => renderRoutes(routes, path);

describe('разделы', () => {
  it('сгруппированы по месту: поиск музыки, сервер, устройство; по умолчанию — «Требуют внимания»; счётчики из сводки', async () => {
    m.summary.mockResolvedValue(
      summary({ available: 4, downloaded: 9, downloading: 3, failed_jobs: 2, missing: 5, partial: 1, searching: 7 }),
    );
    m.downloads.mockResolvedValue(overview({ torrents: [torrent('aaa'), torrent('bbb')] }));
    open();
    expect(await screen.findByTestId('acq-tab-attention')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: L('acq.tabs') });
    const group = (id: string) => within(within(nav).getByTestId(`acq-group-${id}`)).getAllByRole('link');
    expect(group('search').map(a => a.getAttribute('href'))).toEqual([
      '/downloads/attention',
      '/downloads/searching',
      '/downloads/available',
    ]);
    expect(group('server').map(a => a.getAttribute('href'))).toEqual([
      '/downloads/downloading',
      '/downloads/downloaded',
      '/downloads/torrents',
    ]);
    expect(within(nav).getByTestId('acq-group-server')).toHaveTextContent(L('acq.group.server'));
    await waitFor(() => expect(within(nav).getByTestId('acq-tab-link-attention')).toHaveTextContent('6'));
    expect(within(nav).getByTestId('acq-tab-link-searching')).toHaveTextContent('7');
    expect(within(nav).getByTestId('acq-tab-link-downloading')).toHaveTextContent('3');
    expect(within(nav).getByTestId('acq-tab-link-available')).toHaveTextContent('4');
    expect(within(nav).getByTestId('acq-tab-link-downloaded')).toHaveTextContent('9');
    await waitFor(() => expect(within(nav).getByTestId('acq-tab-link-torrents')).toHaveTextContent('2'));
    // «Задачи» переехали в настройки: в «Загрузках» их нет.
    expect(within(nav).queryByText(L('settings.jobs'))).toBeNull();
    // Раздел подписан и объяснён.
    const section = screen.getByTestId('acq-section');
    expect(within(section).getByRole('heading', { name: L('acq.tab.attention') })).toBeInTheDocument();
    expect(section).toHaveTextContent(L('acq.desc.attention'));
  });

  it('действия — в своих разделах: «скачать всё» в «Найдены», пауза — в загрузках и торрентах, хранилище — в «Скачаны»', async () => {
    const all = ['download-all', 'pause-all', 'acq-storage'];
    const cases: [string, string[]][] = [
      ['/downloads/attention', []],
      ['/downloads/searching', []],
      ['/downloads/available', ['download-all']],
      ['/downloads/downloading', ['pause-all']],
      ['/downloads/downloaded', ['acq-storage']],
      ['/downloads/torrents', ['pause-all']],
    ];
    for (const [path, expected] of cases) {
      const { unmount } = open(path);
      await screen.findByTestId('acq-section');
      for (const id of expected) expect(await screen.findByTestId(id)).toBeInTheDocument();
      for (const id of all.filter(id => !expected.includes(id))) expect(screen.queryByTestId(id)).toBeNull();
      unmount();
    }
  });

  it('у группы «Сервер» — занято и свободно на диске сервера', async () => {
    open();
    const meter = await screen.findByTestId('acq-space-server');
    expect(meter).toHaveTextContent('Занято 12 ГБ из 50 ГБ');
    expect(meter).toHaveTextContent('свободно 38 ГБ');
    expect(within(meter).getByRole('progressbar', { name: L('acq.space.serverLabel') })).toBeInTheDocument();
    expect(within(screen.getByTestId('acq-group-search')).queryByRole('progressbar')).toBeNull();
  });

  it('открытый раздел отмечен в списке; «назад» ведёт к списку разделов', async () => {
    const { router } = open('/downloads/searching');
    const link = await screen.findByTestId('acq-tab-link-searching');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('acq-tab-link-attention')).not.toHaveAttribute('aria-current');
    await userEvent.click(screen.getByTestId('acq-back'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/downloads'));
  });

  it('загрузки на сервер на паузе — метка у пункта «Качаются на сервер»', async () => {
    m.downloads.mockResolvedValue(overview({ paused: true }));
    open();
    await waitFor(() => expect(screen.getByTestId('acq-tab-link-downloading')).toHaveTextContent(L('acq.paused')));
  });

  it('нет ненайденного — открывается первый непустой раздел', async () => {
    m.summary.mockResolvedValue(summary({ downloading: 1 }));
    serve({
      'downloading,available': [
        item(7, { download: pinned('downloading', { bytes_done: 5, bytes_total: 10 }), state: 'downloading' }),
      ],
    });
    open();
    expect(await screen.findByTestId('acq-tab-downloading')).toBeInTheDocument();
  });

  it('неизвестный раздел — страница не найдена; старые адреса ведут на торренты и в настройки', async () => {
    const first = open('/downloads/nope');
    await waitFor(() => expect(screen.queryByTestId('acq-tab-attention')).not.toBeInTheDocument());
    expect(screen.queryByTestId('acq-nav')).not.toBeInTheDocument();
    first.unmount();
    const jobs = open('/downloads/jobs');
    await waitFor(() => expect(jobs.router.state.location.pathname).toBe('/settings/jobs'));
    jobs.unmount();
    const { router } = open('/settings/downloads');
    await waitFor(() => expect(router.state.location.pathname).toBe('/downloads/torrents'));
    expect(
      await screen.findByTestId('torrents-list').catch(() => screen.findByText(L('acq.empty.torrents'))),
    ).toBeInTheDocument();
  });
});

describe('«Требуют внимания»', () => {
  it('строка: «найдено N из M», попытки, ближайший повтор, причина с подсказкой, ошибки источников', async () => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    serve({
      'missing,partial': [
        item(1, {
          reason: 'dead_torrents',
          search: {
            attempts: 3,
            candidates: 2,
            last_finished_at: null,
            last_outcome: 'dead_torrents',
            next_retry_at: soon,
            provider_errors: [{ error: 'timeout', source: 'rutracker' }],
          },
          tracks: { adding: 0, found: 1, not_found: 2, ready: 0, total: 3 },
        }),
      ],
    });
    open();
    const row = await screen.findByTestId('acq-row-1');
    expect(row).toHaveTextContent(L('acq.found', { found: 1, total: 3 }));
    expect(row).toHaveTextContent(L('acq.attempts', { count: 3 }));
    expect(row).toHaveTextContent(L('acq.nextRetry', { time: L('acq.minutes', { count: 5 }) }));
    expect(within(row).getByTestId('row-reason')).toHaveTextContent(L('status.reason.dead_torrents'));
    expect(within(row).getByTestId('row-reason')).toHaveTextContent(L('acq.hint.dead_torrents'));
    await userEvent.click(within(row).getByTestId('provider-errors'));
    expect(await screen.findByTestId('provider-errors-list')).toHaveTextContent('RuTracker');
    expect(screen.getByTestId('provider-errors-list')).toHaveTextContent('timeout');
  });

  it('«Повторить поиск» в строке повторяет только этот альбом и сообщает о постановке в очередь', async () => {
    m.retry.mockResolvedValue(1);
    open();
    const row = await screen.findByTestId('acq-row-2');
    await userEvent.click(within(row).getByTestId('row-retry'));
    await waitFor(() => expect(m.retry).toHaveBeenCalledWith({ album_ids: [2], reset_dead: false, scope: 'albums' }));
    expect(toast.success).toHaveBeenCalledWith(L('acq.queued', { count: 1 }));
  });

  it('меню строки: источники и свой magnet', async () => {
    open();
    const row = await screen.findByTestId('acq-row-1');
    await userEvent.click(within(row).getByTestId('row-menu'));
    // Закрытые меню остальных строк скрыты — открытое одно.
    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByTestId('menu-sources')).toHaveAttribute('href', '/album/1/sources');
    await userEvent.click(menu.getByTestId('menu-magnet'));
    expect(await screen.findByTestId('add-magnet-form')).toBeInTheDocument();
  });

  it('«Повторить для всех»: тело scope=missing, reset_dead по флажку; ≤ 50 — без подтверждения', async () => {
    m.retry.mockResolvedValue(2);
    open();
    await screen.findByTestId('acq-row-1');
    await waitFor(() => expect(screen.getByTestId('retry-all')).toBeEnabled());
    expect(screen.getByTestId('retry-all')).toHaveTextContent('(2)');
    await userEvent.click(screen.getByLabelText(L('acq.resetDead')));
    await userEvent.click(screen.getByTestId('retry-all'));
    await waitFor(() => expect(m.retry).toHaveBeenCalledWith({ reset_dead: true, scope: 'missing' }));
    expect(toast.success).toHaveBeenCalledWith(L('acq.queued', { count: 2 }));
  });

  it('больше 50 альбомов — сначала подтверждение с числом', async () => {
    m.summary.mockResolvedValue(summary({ missing: 51 }));
    m.retry.mockResolvedValue(51);
    open();
    await screen.findByTestId('acq-row-1');
    await waitFor(() => expect(screen.getByTestId('retry-all')).toHaveTextContent('(51)'));
    await userEvent.click(screen.getByTestId('retry-all'));
    expect(m.retry).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(L('acq.retryAllConfirm', { count: 51 }));
    await userEvent.click(within(dialog).getByRole('button', { name: L('acq.retryAll', { count: 51 }) }));
    await waitFor(() => expect(m.retry).toHaveBeenCalledWith({ reset_dead: false, scope: 'missing' }));
  });

  it('выбранные строки: «Повторить для выбранных» шлёт их id; «выбрать все загруженные» выбирает все', async () => {
    m.retry.mockResolvedValue(1);
    open();
    await screen.findByTestId('acq-row-1');
    expect(screen.queryByTestId('retry-selected')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(L('acq.selectRow', { title: 'Album 2' })));
    expect(screen.getByTestId('retry-selected')).toHaveTextContent('(1)');
    await userEvent.click(screen.getByLabelText(L('acq.selectAll')));
    expect(screen.getByTestId('retry-selected')).toHaveTextContent('(2)');
    await userEvent.click(screen.getByTestId('retry-selected'));
    await waitFor(() =>
      expect(m.retry).toHaveBeenCalledWith({ album_ids: [1, 2], reset_dead: false, scope: 'albums' }),
    );
    await waitFor(() => expect(screen.queryByTestId('retry-selected')).not.toBeInTheDocument());
  });

  it('ошибка сервера при повторе — toast с понятным текстом, выбор не сбрасывается', async () => {
    m.retry.mockRejectedValue(new ApiError(503, 'backend_unavailable', 'down'));
    open();
    await screen.findByTestId('acq-row-1');
    await userEvent.click(screen.getByLabelText(L('acq.selectRow', { title: 'Album 1' })));
    await userEvent.click(screen.getByTestId('retry-selected'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(L('error.backend_unavailable')));
    expect(screen.getByTestId('retry-selected')).toBeInTheDocument();
  });

  it('следующие страницы догружаются кнопкой «Загрузить ещё»; пустой список — подсказка', async () => {
    m.list.mockImplementation(async q =>
      q.cursor
        ? page(Array.from({ length: 4 }, (_, i) => item(20 + i)))
        : page(
            Array.from({ length: 9 }, (_, i) => item(i + 1)),
            'next',
          ),
    );
    open();
    await screen.findByTestId('acq-row-1');
    await userEvent.click(await screen.findByTestId('acq-more'));
    expect(await screen.findByTestId('acq-row-20')).toBeInTheDocument();
    expect(screen.queryByTestId('acq-more')).not.toBeInTheDocument();
    expect(m.list.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: 'next' });
  });

  it('пусто — «Всё в порядке»; ошибка загрузки — сообщение и «Повторить»', async () => {
    serve({});
    const { unmount } = open();
    expect(await screen.findByText(L('acq.empty.attention'))).toBeInTheDocument();
    unmount();
    m.list.mockRejectedValueOnce(new ApiError(0, 'network', 'x'));
    open();
    expect(await screen.findByText(L('common.loadFailed'))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: L('common.retry') }));
    expect(await screen.findByText(L('acq.empty.attention'))).toBeInTheDocument();
  });
});

describe('«В поиске», «Загружаются», «Доступны», «Скачаны»', () => {
  it('«В поиске»: этап и число задач из job.progress', async () => {
    serve({ searching: [item(4, { active_jobs: 2, state: 'searching' })] });
    open('/downloads/searching');
    const row = await screen.findByTestId('acq-row-4');
    expect(row).toHaveTextContent(L('status.label.adding'));
    expect(row).toHaveTextContent(L('acq.activeJobs', { count: 2 }));
    act(() => appData().live.getState().setAlbumProgress(4, { done: 1, stage: 'verifying', total: 3 }));
    expect(row).toHaveTextContent(L('status.label.verifying', { done: 1, total: 3 }));
  });

  it('«Загружаются»: прогресс из live-store, скорость, пиры, состояние закрепления; «Отменить» снимает закрепление', async () => {
    serve({
      'downloading,available': [
        item(5, {
          download: pinned('downloading', {
            bytes_done: 10 * 1024 ** 2,
            bytes_total: 100 * 1024 ** 2,
            down_bps: 1024 ** 2,
            peers: 4,
          }),
          state: 'downloading',
        }),
        item(6, { download: pinned('waiting_source'), state: 'available' }),
        item(7, { state: 'available' }),
      ],
    });
    m.unpin.mockResolvedValue(undefined);
    open('/downloads/downloading');
    const row = await screen.findByTestId('acq-row-5');
    expect(row).toHaveTextContent('10%');
    expect(row).toHaveTextContent(L('count.peers', { count: 4 }).replace('4 ', '4 '));
    expect(row).toHaveTextContent(L('acq.pin.downloading'));
    expect(screen.getByTestId('acq-row-6')).toHaveTextContent(L('acq.pin.waiting_source'));
    expect(screen.queryByTestId('acq-row-7')).not.toBeInTheDocument();
    act(() =>
      appData()
        .live.getState()
        .setDownloadProgress(5, { bytes_done: 50 * 1024 ** 2, bytes_total: 100 * 1024 ** 2, down_bps: 0, peers: 1 }),
    );
    expect(row).toHaveTextContent('50%');
    await userEvent.click(within(row).getByTestId('row-cancel'));
    await waitFor(() => expect(m.unpin).toHaveBeenCalledWith(5, false));
  });

  it('пауза всех: у строк «на паузе», подпись кнопки и состояние — из ответа, на время запроса кнопка заблокирована', async () => {
    serve({
      'downloading,available': [
        item(5, {
          download: pinned('downloading', { bytes_done: 1, bytes_total: 10, down_bps: 100 }),
          state: 'downloading',
        }),
      ],
    });
    let answer!: (paused: boolean) => void;
    m.pauseAll.mockReturnValue(new Promise<boolean>(r => (answer = r)));
    open('/downloads/downloading');
    const row = await screen.findByTestId('acq-row-5');
    const button = await screen.findByTestId('pause-all');
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveTextContent(L('acq.pauseAll'));
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(m.pauseAll).toHaveBeenCalledWith(true);
    m.downloads.mockResolvedValue(overview({ paused: true }));
    await act(async () => answer(true));
    await waitFor(() => expect(button).toHaveTextContent(L('acq.resumeAll')));
    await waitFor(() => expect(row).toHaveTextContent(L('acq.paused')));
    expect(button).toBeEnabled();
  });

  it('«Доступны»: «Скачать на сервер» оптимистично убирает кнопку в очередь; при ошибке — откат и toast', async () => {
    serve({ available: [item(8, { state: 'available' })] });
    m.summary.mockResolvedValue(summary({ available: 1 }));
    m.pin.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    open('/downloads/available');
    const row = await screen.findByTestId('acq-row-8');
    await userEvent.click(within(row).getByTestId('row-download'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(m.pin).toHaveBeenCalledWith(8);
    // Откат: строка осталась доступной, кнопка на месте.
    expect(await within(await screen.findByTestId('acq-row-8')).findByTestId('row-download')).toBeEnabled();
  });

  it('«Скачаны»: размер и «закреплён»; снять закрепление; удаление файлов — только после подтверждения', async () => {
    serve({
      downloaded: [
        item(9, {
          download: pinned('done', { bytes_done: 300 * 1024 ** 2, bytes_total: 300 * 1024 ** 2 }),
          state: 'downloaded',
        }),
      ],
    });
    m.unpin.mockResolvedValue(undefined);
    m.summary.mockResolvedValue(summary({ downloaded: 1 }));
    open('/downloads/downloaded');
    const row = await screen.findByTestId('acq-row-9');
    expect(row).toHaveTextContent('300 МБ');
    expect(row).toHaveTextContent(L('acq.pinned'));
    await userEvent.click(within(row).getByTestId('row-menu'));
    await userEvent.click(await screen.findByTestId('menu-unpin'));
    await waitFor(() => expect(m.unpin).toHaveBeenCalledWith(9, false));
    m.unpin.mockClear();
    await userEvent.click(within(screen.getByTestId('acq-row-9')).getByTestId('row-menu'));
    await userEvent.click(await screen.findByTestId('menu-delete'));
    expect(m.unpin).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: L('acq.deleteFiles') }));
    await waitFor(() => expect(m.unpin).toHaveBeenCalledWith(9, true));
  });

  it('«Скачать всё доступное»: подтверждение с числом альбомов, затем закрепляются все не закреплённые', async () => {
    m.summary.mockResolvedValue(summary({ available: 3 }));
    serve({
      available: [
        item(11, { state: 'available' }),
        item(12, { state: 'available' }),
        item(13, { download: pinned('queued'), state: 'available' }),
      ],
    });
    m.pin.mockResolvedValue({ pinned: 3 });
    open('/downloads/available');
    await screen.findByTestId('acq-row-11');
    await waitFor(() => expect(screen.getByTestId('download-all')).toBeEnabled());
    await userEvent.click(screen.getByTestId('download-all'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(L('acq.downloadAllConfirm', { count: 3 }));
    await userEvent.click(within(dialog).getByRole('button', { name: L('acq.downloadAll') }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(L('acq.downloadAllDone', { count: 2 })));
    expect(m.pin.mock.calls.map(c => c[0]).sort()).toEqual([11, 12]);
  });
});

describe('«Торренты» и фоновые задачи (в настройках)', () => {
  it('торренты движка: состояние и скорость; пауза одного и возобновление', async () => {
    m.downloads.mockResolvedValue(
      overview({
        torrents: [
          torrent('aaa', { down_bps: 2048, name: 'Moving', peers: 2, progress_bytes: 50 }),
          torrent('bbb', { name: 'Stopped', state: 'paused' }),
        ],
      }),
    );
    m.pauseOne.mockResolvedValue(undefined);
    open('/downloads/torrents');
    const list = await screen.findByTestId('torrents-list');
    expect(within(list).getByTestId('torrent-aaa')).toHaveTextContent(L('acq.torrent.state.downloading'));
    expect(within(list).getByTestId('torrent-aaa')).toHaveTextContent('50%');
    expect(within(list).getByTestId('torrent-bbb')).toHaveTextContent(L('acq.torrent.state.paused'));
    await userEvent.click(within(screen.getByTestId('torrent-aaa')).getByTestId('torrent-pause'));
    await waitFor(() => expect(m.pauseOne).toHaveBeenCalledWith('aaa', true));
    await userEvent.click(within(screen.getByTestId('torrent-bbb')).getByTestId('torrent-resume'));
    await waitFor(() => expect(m.pauseOne).toHaveBeenCalledWith('bbb', false));
  });

  it('торренты: Ratio = отдано за всё время / скачано, без скачанного — 0.00', async () => {
    m.downloads.mockResolvedValue(
      overview({
        torrents: [
          torrent('aaa', { progress_bytes: 200, uploaded_bytes: 10, uploaded_total_bytes: 300 }),
          torrent('bbb', { progress_bytes: 0, uploaded_total_bytes: 5 }),
        ],
      }),
    );
    open('/downloads/torrents');
    expect(await screen.findByTestId('torrent-aaa')).toHaveTextContent(L('acq.torrent.ratio', { value: '1.50' }));
    expect(screen.getByTestId('torrent-bbb')).toHaveTextContent(L('acq.torrent.ratio', { value: '0.00' }));
  });

  it('пустые торренты и пустые задачи — подсказки', async () => {
    const { unmount } = open('/downloads/torrents');
    expect(await screen.findByText(L('acq.empty.torrents'))).toBeInTheDocument();
    unmount();
    open('/settings/jobs');
    expect(await screen.findByText(L('acq.empty.jobs'))).toBeInTheDocument();
  });

  const job = (id: number, over: Partial<api.JobInfo> = {}): api.JobInfo => ({
    attempts: 5,
    id,
    kind: 'discover_album',
    fatal: false,
    last_error: 'provider exploded',
    max_attempts: 5,
    payload: { album_id: 40 + id },
    priority: 0,
    run_after: '2026-11-15T00:00:00Z',
    state: 'failed',
    updated_at: '2026-11-15T00:00:00Z',
    ...over,
  });

  it('упавшие задачи: вид, ссылка на альбом, ошибка, попытки; «Повторить» убирает строку', async () => {
    m.jobs.mockResolvedValue({
      counts: { failed: 2, queued: 0, running: 0 },
      jobs: [job(1), job(2, { kind: 'import_artist', payload: { artist_id: 9 } })],
    });
    m.retryJob.mockResolvedValue({} as never);
    open('/settings/jobs');
    const row = await screen.findByTestId('job-1');
    expect(row).toHaveTextContent(L('acq.job.discover_album'));
    expect(row).toHaveTextContent('provider exploded');
    expect(row).toHaveTextContent(L('acq.job.attempts', { attempts: 5, max: 5 }));
    expect(within(row).getByRole('link')).toHaveAttribute('href', '/album/41');
    expect(within(screen.getByTestId('job-2')).getByRole('link')).toHaveAttribute('href', '/artist/9');
    m.jobs.mockResolvedValue({ counts: { failed: 1, queued: 0, running: 0 }, jobs: [job(2)] });
    await userEvent.click(within(row).getByTestId('job-retry'));
    await waitFor(() => expect(m.retryJob).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.queryByTestId('job-1')).not.toBeInTheDocument());
    expect(screen.getByTestId('job-2')).toBeInTheDocument();
  });

  it('застрявшие состояния: блок скрыт, пока отчёт пуст', async () => {
    open('/settings/jobs');
    expect(await screen.findByText(L('acq.empty.jobs'))).toBeInTheDocument();
    await waitFor(() => expect(m.invariants).toHaveBeenCalled());
    expect(screen.queryByTestId('jobs-stuck')).not.toBeInTheDocument();
  });

  it('застрявшие состояния: число и список (инвариант, сущность, id, подробность)', async () => {
    m.invariants.mockResolvedValue({
      checked_at: '2026-11-17T00:00:00Z',
      grace_secs: 1800,
      sections: [
        {
          count: 2,
          invariant: 'I1',
          violations: [
            { detail: 'tracks in adding: 2', entity: 'album', id: 7, invariant: 'I1' },
            { detail: 'tracks in adding: 1', entity: 'album', id: 8, invariant: 'I1' },
          ],
        },
        { count: 1, invariant: 'I8', violations: [{ detail: '', entity: 'pin', id: 31, invariant: 'I8' }] },
      ],
      total: 3,
    });
    open('/settings/jobs');
    const block = await screen.findByTestId('jobs-stuck');
    expect(within(block).getByRole('heading')).toHaveTextContent(L('settings.jobsStuck', { count: 3 }));
    expect(block).toHaveTextContent(L('settings.jobsStuckHint'));
    const items = within(block).getAllByTestId('stuck-item');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('I1 · album #7');
    expect(items[0]).toHaveTextContent('tracks in adding: 2');
    expect(items[2]).toHaveTextContent('I8 · pin #31');
    // Упавших задач нет — их подсказка на месте: блоки независимы.
    expect(screen.getByText(L('acq.empty.jobs'))).toBeInTheDocument();
  });

  it('409 от сервера — понятное сообщение, строка остаётся', async () => {
    m.jobs.mockResolvedValue({ counts: { failed: 1, queued: 0, running: 0 }, jobs: [job(1)] });
    m.retryJob.mockRejectedValue(new ApiError(409, 'duplicate', 'dup'));
    open('/settings/jobs');
    await userEvent.click(await within(await screen.findByTestId('job-1')).findByTestId('job-retry'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(L('error.duplicate')));
    expect(screen.getByTestId('job-1')).toBeInTheDocument();
  });
});

describe('кнопка «Скачать на сервер» на экране альбома', () => {
  const mount = (row: api.AcquisitionItem | null, online = true) => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
    m.list.mockResolvedValue(page(row ? [row] : []));
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    const router = createMemoryRouter([
      {
        element: (
          <>
            <ServerDownloadButton albumId={1} />
            <AlbumHeaderMenu albumId={1} inLibrary={false} title="Album 1" />
          </>
        ),
        path: '*',
      },
    ]);
    return render(
      <I18nProvider store={createI18nStore({ locale: 'ru', messages: ru })}>
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nProvider>,
    );
  };

  it('нет закрепления → кнопка; нажатие оптимистично показывает «В очереди» и закрепляет', async () => {
    let release!: () => void;
    m.pin.mockReturnValue(new Promise(r => (release = () => r({ pinned: 3 }))));
    mount(item(1, { state: 'available' }));
    await userEvent.click(await screen.findByTestId('server-download'));
    expect(await screen.findByTestId('server-download-progress')).toHaveTextContent(L('acq.server.queued'));
    expect(m.pin).toHaveBeenCalledWith(1);
    release();
  });

  it('при ошибке закрепления — откат к кнопке и toast', async () => {
    m.pin.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    mount(item(1, { state: 'available' }));
    await userEvent.click(await screen.findByTestId('server-download'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(await screen.findByTestId('server-download')).toHaveTextContent(L('acq.server.download'));
  });

  it('идёт загрузка → проценты из live-store; ждёт источник; отмена снимает закрепление', async () => {
    m.unpin.mockResolvedValue(undefined);
    mount(item(1, { download: pinned('downloading', { bytes_done: 10, bytes_total: 100 }), state: 'downloading' }));
    expect(await screen.findByTestId('server-download-progress')).toHaveTextContent(
      L('acq.server.progress', { percent: 10 }),
    );
    act(() =>
      appData().live.getState().setDownloadProgress(1, { bytes_done: 40, bytes_total: 100, down_bps: 1, peers: 1 }),
    );
    expect(screen.getByTestId('server-download-progress')).toHaveTextContent(L('acq.server.progress', { percent: 40 }));
    await userEvent.click(screen.getByTestId('server-download-cancel'));
    await waitFor(() => expect(m.unpin).toHaveBeenCalledWith(1, false));
  });

  it('ждёт источник и ошибка загрузки', async () => {
    const { unmount } = mount(item(1, { download: pinned('waiting_source'), state: 'available' }));
    expect(await screen.findByTestId('server-download-progress')).toHaveTextContent(L('acq.server.waiting'));
    unmount();
    mount(item(1, { download: pinned('failed', { error: 'stalled' }), state: 'available' }));
    await waitFor(() => expect(screen.getByTestId('server-download')).toHaveTextContent(L('acq.server.retry')));
  });

  it('статус запоминается локально: повторное открытие показывает кнопку сразу, без спиннера', async () => {
    const { unmount } = mount(item(1, { state: 'downloaded' }));
    expect(await screen.findByTestId('server-download-done')).toBeInTheDocument();
    unmount();
    mount(item(1, { state: 'downloaded' }));
    expect(screen.queryByTestId('server-download-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('server-download-done')).toBeInTheDocument();
  });

  it('пока статус неизвестен — спиннер на месте кнопки', async () => {
    mount(item(1, { state: 'downloaded' }));
    expect(screen.getByTestId('server-download-loading')).toBeInTheDocument();
    expect(await screen.findByTestId('server-download-done')).toBeInTheDocument();
  });

  it('скачан → «На сервере» и меню «Убрать с сервера» (с подтверждением)', async () => {
    m.unpin.mockResolvedValue(undefined);
    mount(item(1, { download: pinned('done', { bytes_done: 5, bytes_total: 5 }), state: 'downloaded' }));
    expect(await screen.findByTestId('server-download-done')).toHaveTextContent(L('acq.server.done'));
    await userEvent.click(screen.getByTestId('album-menu'));
    await userEvent.click(await screen.findByTestId('menu-remove'));
    expect(m.unpin).not.toHaveBeenCalled();
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: L('acq.deleteFiles') }),
    );
    await waitFor(() => expect(m.unpin).toHaveBeenCalledWith(1, true));
  });

  it('не показывается: альбом ищется / не найден / сервер его не знает / нет сети', async () => {
    for (const [row, online] of [
      [item(1, { state: 'searching' }), true],
      [item(1, { state: 'missing' }), true],
      [null, true],
      [item(1, { state: 'available' }), false],
    ] as const) {
      const { container, unmount } = mount(row, online);
      await waitFor(() => expect(m.list.mock.calls.length > 0 || !online).toBe(true));
      await new Promise(r => setTimeout(r, 20));
      expect(container.querySelector('[data-testid^="server-download"]')).toBeNull();
      unmount();
    }
  });
});

describe('значок «Загрузки» в навигации', () => {
  const bar = () =>
    render(
      <I18nProvider store={createI18nStore({ locale: 'ru', messages: ru })}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <RouterProvider router={createMemoryRouter([{ element: <MobileTabBar items={NAV_ITEMS} />, path: '*' }])} />
        </QueryClientProvider>
      </I18nProvider>,
    );

  it('показывает число альбомов, требующих внимания', async () => {
    m.summary.mockResolvedValue(summary({ missing: 3, partial: 2 }));
    bar();
    expect(await screen.findByTestId('nav-badge-downloads')).toHaveTextContent('5');
    expect(screen.getByLabelText(L('acq.badge', { count: 5 }))).toBeInTheDocument();
  });

  it('нет ненайденного — значка нет; больше 99 — «99+»', async () => {
    m.summary.mockResolvedValue(summary());
    const { unmount } = bar();
    await waitFor(() => expect(m.summary).toHaveBeenCalled());
    expect(screen.queryByTestId('nav-badge-downloads')).not.toBeInTheDocument();
    unmount();
    m.summary.mockResolvedValue(summary({ missing: 150 }));
    bar();
    expect(await screen.findByTestId('nav-badge-downloads')).toHaveTextContent('99+');
  });
});
