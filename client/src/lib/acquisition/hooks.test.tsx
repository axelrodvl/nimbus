import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api/acquisition';
import { appData } from '@/lib/app-data';
import { item, page, summary, torrent } from '@/test/acquisition';
import { useAcquisitionList, useAcquisitionLiveSync, useAcquisitionSummary, useEngineTorrents } from './hooks';
import { ACQ_REFRESH_DEBOUNCE_MS, ENGINE_POLL_MS, listKey } from './keys';

vi.mock('@/lib/api/acquisition', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  getAcquisitionSummary: vi.fn(),
  getDownloads: vi.fn(),
  listAcquisition: vi.fn(),
}));
const m = {
  downloads: vi.mocked(api.getDownloads),
  list: vi.mocked(api.listAcquisition),
  summary: vi.mocked(api.getAcquisitionSummary),
};

class FakeSocket {
  static last: FakeSocket;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  close() {}
}
const emit = (event: Record<string, unknown>) =>
  act(() => FakeSocket.last.onmessage?.({ data: JSON.stringify(event) }));

let qc: QueryClient;
const wrap = (ui: React.ReactNode) => <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  m.summary.mockResolvedValue(summary({ missing: 2 }));
});
afterEach(() => {
  appData().socket.stop();
  vi.useRealTimers();
});

const settle = (ms = ACQ_REFRESH_DEBOUNCE_MS + 10) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('живые обновления', () => {
  function Probe() {
    useAcquisitionLiveSync();
    const s = useAcquisitionSummary();
    return <p data-testid="missing">{s.data?.missing ?? 'none'}</p>;
  }
  const start = async () => {
    appData().socket.start();
    render(wrap(<Probe />));
    await screen.findByText('2');
  };

  it('20 событий acquisition.changed за 200 мс → один перезапрос сводки', async () => {
    await start();
    expect(m.summary).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) {
      emit({ album_id: i, type: 'acquisition.changed' });
      await act(() => vi.advanceTimersByTimeAsync(10));
    }
    expect(m.summary).toHaveBeenCalledTimes(1);
    m.summary.mockResolvedValue(summary({ missing: 1 }));
    await settle();
    expect(m.summary).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('1')).toBeInTheDocument();
    // Новая серия — новый перезапрос.
    emit({ album_id: 1, type: 'acquisition.changed' });
    await settle();
    expect(m.summary).toHaveBeenCalledTimes(3);
  });

  it('download.progress обновляет строку в кэше без запросов', async () => {
    await start();
    const row = item(5, {
      download: { bytes_done: 1, bytes_total: 10, down_bps: 0, peers: 0, pinned: true, state: 'downloading' },
      state: 'downloading',
    });
    qc.setQueryData(listKey(['downloading']), { pageParams: [null], pages: [page([row])] });
    emit({ album_id: 5, bytes_done: 7, bytes_total: 10, down_bps: 2048, peers: 3, type: 'download.progress' });
    const row5 = () =>
      qc.getQueryData<{ pages: { items: api.AcquisitionItem[] }[] }>(listKey(['downloading']))?.pages[0]?.items[0];
    expect(row5()?.download).toMatchObject({
      bytes_done: 7,
      down_bps: 2048,
      peers: 3,
      pinned: true,
      state: 'downloading',
    });
    // Прогресс другого альбома строку не трогает; запросов не было.
    emit({ album_id: 6, bytes_done: 9, bytes_total: 10, down_bps: 1, peers: 1, type: 'download.progress' });
    expect(row5()?.download?.bytes_done).toBe(7);
    expect(m.summary).toHaveBeenCalledTimes(1);
    expect(m.list).not.toHaveBeenCalled();
    // …и попал в live-store для кнопки на экране альбома.
    await appData().engine.settled();
    expect(appData().live.getState().downloadProgress.get(5)).toEqual({
      bytes_done: 7,
      bytes_total: 10,
      down_bps: 2048,
      peers: 3,
    });
  });

  it('переподключение сокета перезапрашивает раздел', async () => {
    await start();
    act(() => FakeSocket.last.onopen?.({}));
    await settle(10);
    const before = m.summary.mock.calls.length;
    act(() => appData().socket.stop());
    appData().socket.start();
    act(() => FakeSocket.last.onopen?.({}));
    await settle(10);
    expect(m.summary.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('бесконечный список', () => {
  function List() {
    const q = useAcquisitionList(['missing']);
    return (
      <div>
        <p data-testid="ids">{q.items.map(i => i.album.id).join(',')}</p>
        <button onClick={() => void q.fetchNextPage()} type="button">
          more
        </button>
        <button onClick={() => void q.refetch()} type="button">
          refetch
        </button>
        <p data-testid="more">{String(q.hasNextPage)}</p>
      </div>
    );
  }

  it('догружает страницы по курсору и не дублирует строки после перезапроса со сдвигом', async () => {
    m.list.mockImplementation(async q => (q.cursor ? page([item(3), item(4)]) : page([item(1), item(2)], 'c1')));
    render(wrap(<List />));
    expect(await screen.findByText('1,2')).toBeInTheDocument();
    expect(m.list.mock.calls[0]?.[0]).toMatchObject({ cursor: null, states: ['missing'] });
    act(() => screen.getByText('more').click());
    expect(await screen.findByText('1,2,3,4')).toBeInTheDocument();
    expect(screen.getByTestId('more')).toHaveTextContent('false');
    // Посреди прокрутки список сдвинулся: строка 2 теперь на второй странице.
    m.list.mockImplementation(async q => (q.cursor ? page([item(2), item(3), item(4)]) : page([item(1)], 'c1')));
    act(() => screen.getByText('refetch').click());
    expect(await screen.findByText('1,2,3,4')).toBeInTheDocument();
  });
});

describe('опрос торрентов движка', () => {
  function Engine({ poll }: { poll: boolean }) {
    const q = useEngineTorrents(poll);
    return <p data-testid="n">{q.data?.torrents.length ?? 'none'}</p>;
  }
  const overview = {
    down_bps: 0,
    paused: false,
    queue: { downloading: 0, failed: 0, queued: 0, waiting_source: 0 },
    torrents: [torrent('a')],
    up_bps: 0,
  };

  it('опрашивает раз в 2 с только при poll=true', async () => {
    m.downloads.mockResolvedValue(overview);
    const { rerender } = render(wrap(<Engine poll />));
    await screen.findByText('1');
    expect(m.downloads).toHaveBeenCalledTimes(1);
    await settle(ENGINE_POLL_MS * 3 + 100);
    expect(m.downloads.mock.calls.length).toBeGreaterThanOrEqual(3);
    rerender(wrap(<Engine poll={false} />));
    const stopped = m.downloads.mock.calls.length;
    await settle(ENGINE_POLL_MS * 3);
    expect(m.downloads).toHaveBeenCalledTimes(stopped);
  });
});
