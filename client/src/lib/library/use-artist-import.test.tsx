import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as libraryApi from '@/lib/api/library';
import { appData } from '@/lib/app-data';
import { makeAlbum, makeArtist, resetFactories } from '@/test/factories';
import { seed } from '@/test/seed';
import { IMPORT_REFRESH_DEBOUNCE_MS, useArtistImport } from './use-artist-import';

vi.mock('@/lib/api/library', async importOriginal => ({
  ...(await importOriginal<typeof libraryApi>()),
  getArtistImport: vi.fn(),
}));
const getImport = vi.mocked(libraryApi.getArtistImport);

function Probe({ enabled = true }: { enabled?: boolean }) {
  const { data } = useArtistImport(1, enabled);
  return <p data-testid="state">{data === undefined ? 'undefined' : (data?.state ?? 'none')}</p>;
}
const mount = (enabled = true) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Probe enabled={enabled} />
    </QueryClientProvider>,
  );

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('WebSocket', FakeSocket);
  resetFactories();
  seed({ albums: [makeAlbum({ artist_id: 1, id: 7 })], artists: [makeArtist({ id: 1 })] });
  getImport.mockResolvedValue({ attempt: 1, max_attempts: 8, state: 'importing' });
});
afterEach(() => {
  appData().socket.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useArtistImport', () => {
  it('выключен — запроса нет и данных нет', () => {
    mount(false);
    expect(getImport).not.toHaveBeenCalled();
    expect(screen.getByTestId('state')).toHaveTextContent('undefined');
  });

  it('включён — один запрос и данные', async () => {
    mount();
    expect(await screen.findByText('importing')).toBeInTheDocument();
    expect(getImport).toHaveBeenCalledTimes(1);
  });
});

describe('обновление по событиям', () => {
  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMPORT_REFRESH_DEBOUNCE_MS + 10);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    appData().socket.start();
  });

  it('серия событий по артисту — один повторный запрос через 1 с', async () => {
    mount();
    await screen.findByText('importing');
    getImport.mockResolvedValue({ attempt: 1, max_attempts: 8, state: 'failed' });
    for (let i = 0; i < 5; i++) emit({ entity: 'artist', id: 1, type: 'library.changed' });
    expect(getImport).toHaveBeenCalledTimes(1);
    await settle();
    expect(getImport).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('failed')).toBeInTheDocument();
  });

  it('прогресс по альбому этого артиста обновляет статус; чужой альбом и чужой артист — нет', async () => {
    mount();
    await screen.findByText('importing');
    emit({ album_id: 999, done: 1, stage: 'searching', total: 2, type: 'job.progress' });
    emit({ entity: 'artist', id: 2, type: 'library.changed' });
    emit({ entity: 'album', id: 1, type: 'library.changed' });
    await settle();
    expect(getImport).toHaveBeenCalledTimes(1);
    emit({ album_id: 7, done: 1, stage: 'searching', total: 2, type: 'job.progress' });
    await settle();
    expect(getImport).toHaveBeenCalledTimes(2);
  });

  it('выключенный хук на события не реагирует; размонтирование гасит отложенный запрос', async () => {
    const off = mount(false);
    emit({ entity: 'artist', id: 1, type: 'library.changed' });
    await settle();
    expect(getImport).not.toHaveBeenCalled();
    off.unmount();
    const on = mount();
    await screen.findByText('importing');
    emit({ entity: 'artist', id: 1, type: 'library.changed' });
    on.unmount();
    await settle();
    expect(getImport).toHaveBeenCalledTimes(1);
  });
});
