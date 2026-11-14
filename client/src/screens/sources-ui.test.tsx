import * as Ariakit from '@ariakit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackSourceDialog } from '@/components/sources/track-source-dialog';
import { ApiError } from '@/lib/api/errors';
import type * as libraryApi from '@/lib/api/library';
import * as sourcesApi from '@/lib/api/sources';
import { appData } from '@/lib/app-data';
import { I18nProvider } from '@/lib/i18n/provider';
import { createI18nStore } from '@/lib/i18n/store';
import ru from '@/lib/i18n/messages/ru';
import { resetPlayer } from '@/lib/player';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { mockLayout, ScrollHost } from '@/test/layout';
import { renderRoutes } from '@/test/render';
import { seed, seedNothing } from '@/test/seed';
import { AlbumScreen } from './library/album';
import { SourcesScreen } from './library/sources';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => true }));
vi.mock('@/lib/api/library', async importOriginal => ({
  ...(await importOriginal<typeof libraryApi>()),
  getArtistImport: vi.fn(async () => null),
}));
vi.mock('@/lib/api/sources', async importOriginal => ({
  ...(await importOriginal<typeof sourcesApi>()),
  addMagnetRequest: vi.fn(),
  confirmSourceRequest: vi.fn(),
  getAlbumTorrents: vi.fn(),
  getTorrentFiles: vi.fn(),
  getTrackSources: vi.fn(),
  retryAlbumRequest: vi.fn(),
  retryTrackRequest: vi.fn(),
  setTrackSourceRequest: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const api = {
  addMagnet: vi.mocked(sourcesApi.addMagnetRequest),
  confirm: vi.mocked(sourcesApi.confirmSourceRequest),
  files: vi.mocked(sourcesApi.getTorrentFiles),
  retryAlbum: vi.mocked(sourcesApi.retryAlbumRequest),
  retryTrack: vi.mocked(sourcesApi.retryTrackRequest),
  setSource: vi.mocked(sourcesApi.setTrackSourceRequest),
  sources: vi.mocked(sourcesApi.getTrackSources),
  torrents: vi.mocked(sourcesApi.getAlbumTorrents),
};

const torrent = (id: number, over: Partial<sourcesApi.AlbumTorrent['torrent']> = {}): sourcesApi.AlbumTorrent => ({
  files_count: 10,
  matched_tracks: 9,
  rank_score: 0.87,
  torrent: {
    id,
    info_hash: `hash${id}`,
    kind: 'album',
    leechers: 3,
    meta_status: 'ok',
    seeders: 40,
    size_bytes: 300 * 1024 * 1024,
    source: 'rutracker',
    title: `Torrent ${id}`,
    ...over,
  },
  verified: true,
});

const source = (id: number, over: Partial<sourcesApi.TrackSource> = {}): sourcesApi.TrackSource => ({
  file_index: id,
  id,
  is_primary: false,
  match_score: 0.93,
  needs_confirmation: false,
  path: `Album/0${id} Song.flac`,
  size_bytes: 30 * 1024 * 1024,
  torrent: torrent(1).torrent,
  ...over,
});

let restore: () => void;
beforeEach(() => {
  resetFactories();
  vi.clearAllMocks();
  restore = mockLayout({ height: 2000, width: 1000 });
  api.torrents.mockResolvedValue([torrent(1), torrent(2, { kind: 'discography', source: 'manual', title: 'Mine' })]);
  api.sources.mockResolvedValue([source(1, { is_primary: true }), source(2, { needs_confirmation: true })]);
  api.files.mockResolvedValue([
    { ext: 'flac', file_index: 0, matched_track_id: 11, path: 'Album/01 One.flac', size_bytes: 1024 },
    { ext: 'jpg', file_index: 1, matched_track_id: null, path: 'Album/cover.jpg', size_bytes: 2048 },
  ]);
  api.setSource.mockResolvedValue({} as never);
  api.confirm.mockResolvedValue({} as never);
  api.retryAlbum.mockResolvedValue({ queued: true, tracks_reset: 2 });
  api.retryTrack.mockResolvedValue({ queued: true, tracks_reset: 1 });
  api.addMagnet.mockResolvedValue({ queued: true, torrent: torrent(3).torrent });
  vi.spyOn(appData().engine, 'requestSync').mockImplementation(() => undefined);
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 2, title: 'Alb' })],
    artists: [makeArtist({ id: 1, name: 'Art' })],
    tracks: [
      makeTrack({ album_id: 2, artist_id: 1, id: 11, position: 1, status: 'found', title: 'One' }),
      makeTrack({ album_id: 2, artist_id: 1, id: 12, needs_confirmation: true, position: 2, status: 'found', title: 'Two' }),
    ],
  });
});
afterEach(() => {
  restore();
  resetPlayer(true);
});

const routes = [
  { element: <SourcesScreen />, path: '/album/:id/sources' },
  {
    element: (
      <ScrollHost>
        <AlbumScreen />
      </ScrollHost>
    ),
    path: '/album/:id',
  },
];

describe('экран источников альбома', () => {
  it('список раздач: название, источник, тип, размер, сиды/личи, статус метаданных, треки', async () => {
    renderRoutes(routes, '/album/2/sources');
    const items = await screen.findAllByTestId('torrent-item');
    expect(items).toHaveLength(2);
    const first = within(items[0]!);
    expect(first.getByText('Torrent 1')).toBeInTheDocument();
    expect(first.getByText('RuTracker')).toBeInTheDocument();
    expect(first.getByText('Альбом')).toBeInTheDocument();
    expect(first.getByText('300 МБ')).toBeInTheDocument();
    expect(first.getByText('40/3')).toBeInTheDocument();
    expect(first.getByText('9 тр.')).toBeInTheDocument();
    expect(first.getByTestId('torrent-meta')).toHaveTextContent('Метаданные получены');
    expect(within(items[1]!).getByText('Свой')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Дискография')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Alb/ })).toHaveAttribute('href', '/album/2');
    expect(document.title).toBe('Источники · Nimbus');
  });

  it('все статусы метаданных, неизвестные сиды и размер', async () => {
    const statuses = ['pending', 'fetching', 'ok', 'timeout', 'dead', 'error'] as const;
    api.torrents.mockResolvedValue(
      statuses.map((s, i) =>
        torrent(i + 1, { leechers: null, meta_status: s, seeders: null, size_bytes: null, title: `T-${s}` }),
      ),
    );
    renderRoutes(routes, '/album/2/sources');
    const metas = (await screen.findAllByTestId('torrent-meta')).map(m => m.textContent);
    expect(metas).toEqual(['Ожидает', 'Загрузка метаданных…', 'Метаданные получены', 'Нет ответа', 'Мёртвая', 'Ошибка']);
    expect(screen.getAllByText('?/?')).toHaveLength(6);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(6);
  });

  it('раскрытие раздачи: файлы с сопоставленным треком; без метаданных — подсказка', async () => {
    renderRoutes(routes, '/album/2/sources');
    const first = (await screen.findAllByTestId('torrent-item'))[0]!;
    await userEvent.click(within(first).getByRole('button'));
    const files = await within(first).findAllByTestId('torrent-file');
    expect(files).toHaveLength(2);
    expect(within(files[0]!).getByText('One')).toBeInTheDocument();
    expect(within(files[1]!).queryByText('One')).not.toBeInTheDocument();
    api.files.mockResolvedValue([]);
    const second = screen.getAllByTestId('torrent-item')[1]!;
    await userEvent.click(within(second).getByRole('button'));
    expect(await within(second).findByText(/Файлы ещё неизвестны/)).toBeInTheDocument();
    await userEvent.click(within(first).getByRole('button'));
    expect(within(first).queryAllByTestId('torrent-file')).toHaveLength(0);
  });

  it('файл сопоставлен с неизвестным треком — запасное название', async () => {
    api.files.mockResolvedValue([{ ext: 'flac', file_index: 0, matched_track_id: 555, path: 'x.flac', size_bytes: 1 }]);
    renderRoutes(routes, '/album/2/sources');
    await userEvent.click(within((await screen.findAllByTestId('torrent-item'))[0]!).getByRole('button'));
    expect(await screen.findByText('трек #555')).toBeInTheDocument();
  });

  it('ошибка загрузки файлов — «Повторить»', async () => {
    api.files.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    renderRoutes(routes, '/album/2/sources');
    await userEvent.click(within((await screen.findAllByTestId('torrent-item'))[0]!).getByRole('button'));
    await userEvent.click(await screen.findByRole('button', { name: 'Повторить' }));
    expect(await screen.findAllByTestId('torrent-file')).toHaveLength(2);
  });

  it('раздач нет — подсказка; загрузка — skeleton; ошибка — «Повторить»', async () => {
    api.torrents.mockResolvedValue([]);
    renderRoutes(routes, '/album/2/sources');
    expect(screen.getByTestId('sources-skeleton')).toBeInTheDocument();
    expect(await screen.findByTestId('no-torrents')).toBeInTheDocument();
  });

  it('ошибка загрузки раздач: сообщение и повтор', async () => {
    api.torrents.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    renderRoutes(routes, '/album/2/sources');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось загрузить');
    await userEvent.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await screen.findAllByTestId('torrent-item')).toHaveLength(2);
  });

  it('без сети и без данных — сообщение про сеть', async () => {
    vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(false);
    api.torrents.mockImplementation(() => new Promise(() => undefined));
    renderRoutes(routes, '/album/2/sources');
    expect(await screen.findByText(/Нет сети — раздачи загрузятся/)).toBeInTheDocument();
  });

  it('несуществующий или неверный альбом — «не найдено»; до гидратации запросов нет', async () => {
    renderRoutes(routes, '/album/999/sources');
    expect(screen.getByText('Не найдено', { selector: 'h1' })).toBeInTheDocument();
    expect(api.torrents).not.toHaveBeenCalled();
  });

  it('неверный id', () => {
    renderRoutes(routes, '/album/abc/sources');
    expect(screen.getByText('Не найдено', { selector: 'h1' })).toBeInTheDocument();
    expect(api.torrents).not.toHaveBeenCalled();
  });

  it('до гидратации экран рисуется без «не найдено»', () => {
    seedNothing();
    renderRoutes(routes, '/album/2/sources');
    expect(screen.queryByText('Не найдено', { selector: 'h1' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Источники' })).toBeInTheDocument();
  });

  it('«Повторить поиск»: запрос, toast, синхронизация', async () => {
    renderRoutes(routes, '/album/2/sources');
    await userEvent.click(await screen.findByTestId('retry-album'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Поиск запущен заново'));
    expect(api.retryAlbum).toHaveBeenCalledWith(2);
    expect(appData().engine.requestSync).toHaveBeenCalledWith('sources');
  });

  it('ошибка повтора поиска показывается', async () => {
    api.retryAlbum.mockRejectedValue(new ApiError(404, 'not_found', 'album gone'));
    renderRoutes(routes, '/album/2/sources');
    await userEvent.click(await screen.findByTestId('retry-album'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('album gone'));
  });

  it('ссылка «Источники» в шапке альбома ведёт сюда', async () => {
    const { router } = renderRoutes(routes, '/album/2');
    await userEvent.click(screen.getByTestId('album-sources-link'));
    expect(router.state.location.pathname).toBe('/album/2/sources');
  });
});

describe('форма «Свой magnet»', () => {
  const HEX = '0123456789abcdef0123456789abcdef01234567';
  const field = () => screen.findByRole('textbox', { name: 'Magnet-ссылка' });
  const submit = () => screen.getByRole('button', { name: 'Добавить magnet' });

  it('пусто: кнопка выключена, ошибки нет', async () => {
    renderRoutes(routes, '/album/2/sources');
    await field();
    expect(submit()).toBeDisabled();
    expect(screen.getByTestId('magnet-error')).toBeEmptyDOMElement();
  });

  it('неверный формат (без xt) — ошибка и кнопка выключена, запроса нет', async () => {
    renderRoutes(routes, '/album/2/sources');
    await userEvent.type(await field(), 'magnet:?dn=name');
    expect(screen.getByTestId('magnet-error')).toHaveTextContent('Это не magnet-ссылка');
    expect(submit()).toBeDisabled();
    expect(await field()).toHaveAttribute('aria-invalid', 'true');
    await userEvent.type(await field(), '{Enter}');
    expect(api.addMagnet).not.toHaveBeenCalled();
  });

  it('валидная ссылка: запрос, очистка поля, toast, обновление списка', async () => {
    renderRoutes(routes, '/album/2/sources');
    await screen.findAllByTestId('torrent-item');
    api.torrents.mockResolvedValue([torrent(1), torrent(2), torrent(3, { source: 'manual', title: 'Added' })]);
    await userEvent.type(await field(), `  magnet:?xt=urn:btih:${HEX}&dn=A `);
    await userEvent.click(submit());
    await waitFor(() => expect(api.addMagnet).toHaveBeenCalledWith(2, `magnet:?xt=urn:btih:${HEX}&dn=A`));
    expect(toast.success).toHaveBeenCalledWith('Раздача добавлена, проверяем');
    expect(await field()).toHaveValue('');
    await waitFor(() => expect(screen.getAllByTestId('torrent-item')).toHaveLength(3));
  });

  it('ошибка сервера: toast с переводом кода, поле сохраняется', async () => {
    api.addMagnet.mockRejectedValue(new ApiError(400, 'invalid_magnet', 'bad'));
    renderRoutes(routes, '/album/2/sources');
    await userEvent.type(await field(), `magnet:?xt=urn:btih:${HEX}`);
    await userEvent.click(submit());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Это не magnet-ссылка'));
    expect(await field()).toHaveValue(`magnet:?xt=urn:btih:${HEX}`);
  });
});

function Harness({ trackId = 12, albumId = 2 }: { trackId?: number; albumId?: number }) {
  const store = Ariakit.useDialogStore({ defaultOpen: true });
  return <TrackSourceDialog albumId={albumId} store={store} title="Two" trackId={trackId} />;
}
const renderDialog = (props: { trackId?: number; albumId?: number } = {}) =>
  render(
    <I18nProvider store={createI18nStore({ locale: 'ru', messages: ru })}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Harness {...props} />
      </QueryClientProvider>
    </I18nProvider>,
  );

describe('диалог источника трека', () => {
  it('текущий источник отмечен, у сомнительного — «проверьте» и «Подтвердить»; качество из расширения', async () => {
    renderDialog();
    const items = await screen.findAllByTestId('source-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-primary', 'true');
    expect(within(items[0]!).getByRole('img', { name: 'Выбран' })).toBeInTheDocument();
    expect(within(items[0]!).queryByRole('button', { name: 'Выбрать' })).not.toBeInTheDocument();
    expect(within(items[0]!).getByText(/совпадение 93%/)).toBeInTheDocument();
    expect(within(items[0]!).getByTestId('audio-quality')).toHaveTextContent('FLAC');
    expect(within(items[1]!).getByTestId('source-needs-check')).toBeInTheDocument();
    expect(within(items[1]!).getByRole('button', { name: 'Подтвердить' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Источник трека «Two»' })).toBeInTheDocument();
  });

  it('выбор другого источника: запрос, toast, окно закрывается', async () => {
    renderDialog();
    const items = await screen.findAllByTestId('source-item');
    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Выбрать' }));
    await waitFor(() => expect(api.setSource).toHaveBeenCalledWith(12, { source_id: 2 }));
    expect(toast.success).toHaveBeenCalledWith('Источник выбран');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('подтверждение сомнительного: запрос, список обновляется, окно остаётся', async () => {
    renderDialog();
    const items = await screen.findAllByTestId('source-item');
    api.sources.mockResolvedValue([source(1, { is_primary: true }), source(2)]);
    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith(12, 2));
    expect(toast.success).toHaveBeenCalledWith('Подтверждено');
    await waitFor(() => expect(screen.queryByTestId('source-needs-check')).not.toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('ошибка сервера при выборе показывается, окно остаётся', async () => {
    api.setSource.mockRejectedValue(new ApiError(400, 'bad_source', 'cannot use this file'));
    renderDialog();
    const items = await screen.findAllByTestId('source-item');
    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Выбрать' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('cannot use this file'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('повтор поиска для трека', async () => {
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Повторить поиск' }));
    await waitFor(() => expect(api.retryTrack).toHaveBeenCalledWith(12));
    expect(toast.success).toHaveBeenCalledWith('Поиск запущен заново');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('ручной выбор: раздачи → файлы → выбор файла', async () => {
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Выбрать файл вручную' }));
    const torrents = await screen.findAllByTestId('dialog-torrent');
    expect(torrents).toHaveLength(2);
    await userEvent.click(torrents[1]!);
    const files = await screen.findAllByTestId('dialog-file');
    expect(files).toHaveLength(2);
    await userEvent.click(files[0]!);
    await waitFor(() => expect(api.setSource).toHaveBeenCalledWith(12, { file_index: 0, torrent_id: 2 }));
  });

  it('кнопки «Назад» ведут по шагам обратно', async () => {
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Выбрать файл вручную' }));
    await userEvent.click((await screen.findAllByTestId('dialog-torrent'))[0]!);
    await screen.findAllByTestId('dialog-file');
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findAllByTestId('dialog-torrent')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findAllByTestId('source-item')).toHaveLength(2);
  });

  it('пусто: нет источников и нет раздач', async () => {
    api.sources.mockResolvedValue([]);
    api.torrents.mockResolvedValue([]);
    renderDialog();
    expect(await screen.findByText('Источников нет.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Выбрать файл вручную' }));
    expect(await screen.findByText('У альбома нет раздач.')).toBeInTheDocument();
  });

  it('пусто: у раздачи файлы ещё неизвестны', async () => {
    api.files.mockResolvedValue([]);
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Выбрать файл вручную' }));
    await userEvent.click((await screen.findAllByTestId('dialog-torrent'))[0]!);
    expect(await screen.findByText('Файлы ещё неизвестны.')).toBeInTheDocument();
  });

  it('ошибка загрузки источников — «Повторить»', async () => {
    api.sources.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    renderDialog();
    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await screen.findAllByTestId('source-item')).toHaveLength(2);
  });

  it('ошибки загрузки раздач и файлов — «Повторить»', async () => {
    renderDialog();
    api.torrents.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    await userEvent.click(await screen.findByRole('button', { name: 'Выбрать файл вручную' }));
    await userEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Повторить' }));
    const torrents = await screen.findAllByTestId('dialog-torrent');
    api.files.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    await userEvent.click(torrents[0]!);
    await userEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Повторить' }));
    expect(await screen.findAllByTestId('dialog-file')).toHaveLength(2);
  });

  it('событие статуса альбома обновляет источники открытого окна', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
    vi.stubGlobal('WebSocket', FakeSocket);
    appData().socket.start();
    try {
      renderDialog();
      await screen.findAllByTestId('source-item');
      expect(api.sources).toHaveBeenCalledTimes(1);
      act(() =>
        FakeSocket.last.onmessage?.({
          data: JSON.stringify({ album_id: 2, reason: null, status: 'ready', track_id: 12, type: 'track.status' }),
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(api.sources).toHaveBeenCalledTimes(2);
    } finally {
      appData().socket.stop();
      vi.useRealTimers();
    }
  });
});

describe('бейдж «требует подтверждения» в строке трека', () => {
  it('клик открывает диалог выбора источника', async () => {
    renderRoutes(routes, '/album/2');
    const row = document.querySelector('[data-track-id="12"]') as HTMLElement;
    await userEvent.click(within(row).getByTestId('needs-confirmation'));
    expect(await screen.findByRole('dialog', { name: 'Источник трека «Two»' })).toBeInTheDocument();
    expect(await screen.findAllByTestId('source-item')).toHaveLength(2);
  });

  it('пункт меню «Выбрать источник» открывает тот же диалог; у трека без сомнений бейджа нет', async () => {
    renderRoutes(routes, '/album/2');
    const row = document.querySelector('[data-track-id="11"]') as HTMLElement;
    expect(within(row).queryByTestId('needs-confirmation')).not.toBeInTheDocument();
    await userEvent.click(within(row).getByTestId('track-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Выбрать источник' }));
    expect(await screen.findByRole('dialog', { name: 'Источник трека «One»' })).toBeInTheDocument();
  });

  it('повтор поиска из меню ненайденного трека', async () => {
    seed({
      albums: [makeAlbum({ artist_id: 1, id: 2, title: 'Alb' })],
      artists: [makeArtist({ id: 1, name: 'Art' })],
      tracks: [makeTrack({ album_id: 2, artist_id: 1, id: 13, position: 1, status: 'not_found', title: 'Gone' })],
    });
    renderRoutes(routes, '/album/2');
    await userEvent.click(within(document.querySelector('[data-track-id="13"]') as HTMLElement).getByTestId('track-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Повторить поиск' }));
    await waitFor(() => expect(api.retryTrack).toHaveBeenCalledWith(13));
    expect(toast.success).toHaveBeenCalledWith('Поиск запущен заново');
  });

  it('ошибка повтора поиска из меню показывается', async () => {
    api.retryTrack.mockRejectedValue(new ApiError(409, 'track_ready', 'ready'));
    seed({
      albums: [makeAlbum({ artist_id: 1, id: 2, title: 'Alb' })],
      artists: [makeArtist({ id: 1, name: 'Art' })],
      tracks: [makeTrack({ album_id: 2, artist_id: 1, id: 13, position: 1, status: 'not_found', title: 'Gone' })],
    });
    renderRoutes(routes, '/album/2');
    await userEvent.click(within(document.querySelector('[data-track-id="13"]') as HTMLElement).getByTestId('track-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Повторить поиск' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Трек уже скачан'));
  });
});
