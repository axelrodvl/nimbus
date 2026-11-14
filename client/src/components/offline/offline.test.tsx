import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RowMenu } from '@/components/library/row-menu';
import { resetAppData } from '@/lib/app-data';
import { installOffline } from '@/lib/offline';
import { useAlbumOffline } from '@/lib/offline/hooks';
import type { OfflineItemState } from '@/lib/offline/status';
import { makeAlbum, makeArtist, makePlaylist, makePlaylistTrack, makeTrack, resetFactories } from '@/test/factories';
import { fileStatus, installOfflineUi, type OfflineUi } from '@/test/offline-ui';
import { renderWithProviders } from '@/test/render';
import { seed } from '@/test/seed';
import { AlbumOfflineBadge } from './album-badge';
import { OfflineButton } from './offline-button';
import { OfflineQueueIndicator } from './queue-indicator';
import { ProgressRing } from './ring';
import { OfflineControl } from './subject-control';
import { TrackOfflineIndicator } from './track-offline';

let ui: OfflineUi;

beforeEach(() => {
  resetFactories();
  seed({
    albums: [makeAlbum({ artist_id: 1, id: 1, title: 'Alb' })],
    artists: [makeArtist({ id: 1 })],
    playlistTracks: [makePlaylistTrack({ id: 1, playlist_id: 5, track_id: 1 })],
    playlists: [makePlaylist({ id: 5, name: 'Mix' })],
    tracks: [
      makeTrack({ album_id: 1, id: 1, play_count: 3, position: 1, title: 'Song' }),
      makeTrack({ album_id: 1, id: 2, position: 2, title: 'Other' }),
    ],
  });
  ui = installOfflineUi();
});
afterEach(async () => {
  installOffline(null);
  await resetAppData(true);
});

describe('ProgressRing', () => {
  it('доля ограничена 0…1', () => {
    const { container, rerender } = renderWithProviders(<ProgressRing progress={0.25} size={32} />);
    expect(container.querySelector('[data-progress]')?.getAttribute('data-progress')).toBe('25');
    rerender(<ProgressRing progress={4} size={32} />);
  });
});

function button(state: OfflineItemState, over: Partial<React.ComponentProps<typeof OfflineButton>> = {}) {
  const h = { onCancel: vi.fn(), onPin: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn() };
  renderWithProviders(<OfflineButton {...h} state={state} title="Alb" {...over} />);
  return h;
}

describe('OfflineButton', () => {
  it('none: «Скачать на устройство» закрепляет', async () => {
    const h = button({ kind: 'none' });
    const b = screen.getByRole('button', { name: 'Скачать на устройство: Alb' });
    expect(b).toHaveAttribute('data-state', 'none');
    await userEvent.click(b);
    expect(h.onPin).toHaveBeenCalledTimes(1);
  });

  it('queued: часы, нажатие отменяет', async () => {
    const h = button({ kind: 'queued' });
    await userEvent.click(screen.getByRole('button', { name: /Ждёт скачивания на устройство: Alb/ }));
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it('downloading: кольцо с долей в имени, нажатие отменяет', async () => {
    const h = button({ kind: 'downloading', progress: 0.42 });
    const b = screen.getByRole('button', { name: /Скачивается на устройство: Alb, 42%/ });
    expect(b.querySelector('[data-progress="42"]')).not.toBeNull();
    await userEvent.click(b);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it('done: галочка, меню «Удалить с устройства»', async () => {
    const h = button({ kind: 'done' });
    await userEvent.click(screen.getByRole('button', { name: /Доступно офлайн: Alb/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Удалить с устройства' }));
    expect(h.onRemove).toHaveBeenCalledTimes(1);
    expect(h.onPin).not.toHaveBeenCalled();
  });

  it('failed: восклицательный знак, нажатие повторяет', async () => {
    const h = button({ kind: 'failed' });
    await userEvent.click(screen.getByRole('button', { name: /Не удалось скачать: Alb/ }));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
  });

  it('partial: не закреплено — докачать; закреплено — меню «повторить / удалить»; кольцо показывает долю', async () => {
    const a = button({ kind: 'partial' }, { fraction: 0.5, pinned: false });
    const b = screen.getByRole('button', { name: /Скачано частично \(50%\): Alb/ });
    expect(b.querySelector('[data-progress="50"]')).not.toBeNull();
    await userEvent.click(b);
    expect(a.onPin).toHaveBeenCalledTimes(1);
  });

  it('partial закреплённый: меню с повтором и удалением', async () => {
    const h = button({ kind: 'partial' }, { fraction: 0.2, pinned: true });
    await userEvent.click(screen.getByRole('button', { name: /Скачано частично \(20%\)/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Повторить неудавшиеся' }));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /Скачано частично/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Удалить с устройства' }));
    expect(h.onRemove).toHaveBeenCalledTimes(1);
  });

  it('с подписью: видимый текст состояния; размеры sm и md различаются', () => {
    const { unmount } = renderWithProviders(
      <OfflineButton
        onCancel={vi.fn()}
        onPin={vi.fn()}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        size="sm"
        state={{ kind: 'none' }}
        title="T"
        withLabel
      />,
    );
    expect(screen.getByText('На устройство')).toBeInTheDocument();
    unmount();
    renderWithProviders(
      <OfflineButton
        onCancel={vi.fn()}
        onPin={vi.fn()}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        state={{ kind: 'downloading', progress: 0.5 }}
        title="T"
        withLabel
      />,
    );
    expect(screen.getByText('Скачивается 50%')).toBeInTheDocument();
  });
});

describe('OfflineControl (шапка альбома)', () => {
  function Header() {
    const summary = useAlbumOffline(1);
    return <OfflineControl subject={{ id: 1, kind: 'album', title: 'Alb', trackIds: [1, 2] }} summary={summary} />;
  }

  it('«Скачано N из M · X»: размер — по факту; кнопка закрепляет альбом', async () => {
    renderWithProviders(<Header />);
    expect(screen.queryByTestId('offline-summary')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Скачать на устройство: Alb/ }));
    expect(ui.manager.pin).toHaveBeenCalledWith('album', 1);
    ui.set({ 1: fileStatus('done', 2048, 2048), 2: fileStatus('downloading', 0, null) });
    expect(screen.getByTestId('offline-summary')).toHaveTextContent('Скачано 1 из 2 · 2.0 КБ');
    // Идёт загрузка без размера: байтов ещё нет, остаётся только число треков.
    ui.set({ 1: fileStatus('queued'), 2: fileStatus('queued') });
    expect(screen.getByTestId('offline-summary')).toHaveTextContent(/^Скачано 0 из 2$/);
  });

  it('удаление снимает закрепление альбома и треков', async () => {
    renderWithProviders(<Header />);
    ui.set({ 1: fileStatus('done', 1, 1), 2: fileStatus('done', 1, 1) }, { pins: new Set(['album:1']) });
    await userEvent.click(screen.getByRole('button', { name: /Доступно офлайн: Alb/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Удалить с устройства' }));
    await waitFor(() => expect(ui.manager.unpin).toHaveBeenCalledWith('album', 1));
    expect(ui.manager.unpin).toHaveBeenCalledWith('track', 2);
  });

  it('частично скачанный закреплённый альбом: «повторить» повторяет упавшие', async () => {
    renderWithProviders(<Header />);
    ui.set({ 1: fileStatus('done', 1, 1), 2: fileStatus('failed') }, { pins: new Set(['album:1']) });
    await userEvent.click(screen.getByRole('button', { name: /Скачано частично/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Повторить неудавшиеся' }));
    expect(ui.manager.retry).toHaveBeenCalledWith(2);
    expect(ui.manager.retry).toHaveBeenCalledTimes(1);
  });

  it('без поддержки ничего не рисуется', () => {
    installOfflineUi({ supported: false });
    const { container } = renderWithProviders(<Header />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('индикаторы', () => {
  it('строка трека: каждое состояние своим значком; «нет» и «поддержки нет» — пусто', () => {
    const { container } = renderWithProviders(<TrackOfflineIndicator trackId={1} />);
    expect(container).toBeEmptyDOMElement();
    ui.set({ 1: fileStatus('done', 1, 1) });
    expect(screen.getByRole('img', { name: 'Доступен офлайн' })).toHaveAttribute('data-state', 'done');
    ui.set({ 1: fileStatus('downloading', 4, 10) });
    expect(screen.getByRole('img', { name: 'Скачивается, 40%' })).toBeInTheDocument();
    ui.set({ 1: fileStatus('queued') });
    expect(screen.getByRole('img', { name: 'Ждёт скачивания' })).toBeInTheDocument();
    ui.set({ 1: fileStatus('failed') });
    expect(screen.getByRole('img', { name: 'Не удалось скачать' })).toBeInTheDocument();
  });

  it('карточка альбома: отметка «скачан» только когда скачан весь альбом', () => {
    renderWithProviders(<AlbumOfflineBadge albumId={1} />);
    expect(screen.queryByTestId('album-offline-badge')).toBeNull();
    ui.set({ 1: fileStatus('done', 1, 1), 2: fileStatus('downloading', 1, 2) });
    expect(screen.queryByTestId('album-offline-badge')).toBeNull();
    ui.set({ 1: fileStatus('done', 1, 1), 2: fileStatus('done', 1, 1) });
    expect(screen.getByTestId('album-offline-badge')).toBeInTheDocument();
  });

  it('глобальный индикатор: виден, пока есть очередь; ведёт на «На устройстве»; полоска для мобильных', () => {
    const { container } = renderWithProviders(
      <>
        <OfflineQueueIndicator />
        <OfflineQueueIndicator variant="strip" />
      </>,
    );
    expect(container.querySelector('a')).toBeNull();
    ui.set({ 1: fileStatus('downloading', 5, 10), 2: fileStatus('queued') }, { activeCount: 1, queueLength: 1 });
    const links = screen.getAllByRole('link', { name: /Скачивание на устройство: \d+%/ });
    expect(links).toHaveLength(2);
    for (const a of links) expect(a).toHaveAttribute('href', '/downloads/device');
    expect(screen.getByTestId('offline-queue-strip')).toHaveTextContent('Скачивание на устройство');
    ui.set({ 1: fileStatus('done', 1, 1), 2: fileStatus('done', 1, 1) }, { activeCount: 0, queueLength: 0 });
    expect(screen.queryByTestId('offline-queue-indicator')).toBeNull();
  });

  it('без поддержки индикатор скрыт', () => {
    installOfflineUi({ supported: false });
    const { container } = renderWithProviders(<OfflineQueueIndicator />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('меню трека', () => {
  const menu = () => (
    <RowMenu albumId={1} onAddToPlaylist={vi.fn()} onSource={vi.fn()} status="ready" title="Song" trackId={1} />
  );
  const openMenu = async () => {
    await userEvent.click(screen.getByTestId('track-menu'));
    return screen.findByTestId('track-offline-item');
  };

  it('не скачан: «Скачать на устройство» закрепляет трек', async () => {
    renderWithProviders(menu());
    const item = await openMenu();
    expect(item).toHaveTextContent('Скачать на устройство');
    await userEvent.click(item);
    expect(ui.manager.pin).toHaveBeenCalledWith('track', 1);
  });

  it('скачан сам по себе: «Удалить с устройства» снимает закрепление трека', async () => {
    renderWithProviders(menu());
    ui.set({ 1: fileStatus('done', 1, 1) }, { pins: new Set(['track:1']) });
    const item = await openMenu();
    expect(item).toHaveTextContent('Удалить с устройства');
    await userEvent.click(item);
    await waitFor(() => expect(ui.manager.unpin).toHaveBeenCalledWith('track', 1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('скачан в составе закреплённого альбома: предлагает снять закрепление альбома', async () => {
    renderWithProviders(menu());
    ui.set({ 1: fileStatus('done', 1, 1), 2: fileStatus('done', 1, 1) }, { pins: new Set(['album:1']) });
    await userEvent.click(await openMenu());
    const dialog = await screen.findByRole('dialog', { name: 'Снять закрепление альбома?' });
    expect(dialog).toHaveTextContent('«Alb»');
    expect(ui.manager.unpin).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Снять закрепление альбома' }));
    await waitFor(() => expect(ui.manager.unpin).toHaveBeenCalledWith('album', 1));
    expect(ui.manager.unpin).toHaveBeenCalledWith('track', 1);
  });

  it('скачан в составе плейлиста и в составе «Избранного»: диалог про плейлист', async () => {
    renderWithProviders(menu());
    ui.set({ 1: fileStatus('done', 1, 1) }, { pins: new Set(['playlist:5']) });
    await userEvent.click(await openMenu());
    const dialog = await screen.findByRole('dialog', { name: 'Снять закрепление плейлиста?' });
    expect(dialog).toHaveTextContent('«Mix»');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(ui.manager.unpin).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // «Избранное» (playlist:0): трек в нём, пока у него есть прослушивания.
    ui.set({ 1: fileStatus('done', 1, 1) }, { pins: new Set(['playlist:0']) });
    await userEvent.click(await openMenu());
    const fav = await screen.findByRole('dialog', { name: 'Снять закрепление плейлиста?' });
    expect(fav).toHaveTextContent('«Любимое»');
  });

  it('состояние есть, а закрепления нет (чужая вкладка): просто снимает закрепление трека', async () => {
    renderWithProviders(menu());
    ui.set({ 1: fileStatus('done', 1, 1) });
    await userEvent.click(await openMenu());
    await waitFor(() => expect(ui.manager.unpin).toHaveBeenCalledWith('track', 1));
  });

  it('без поддержки пункта нет', async () => {
    installOfflineUi({ supported: false });
    renderWithProviders(menu());
    await userEvent.click(screen.getByTestId('track-menu'));
    await screen.findByRole('menuitem', { name: /плейлист/i });
    expect(screen.queryByTestId('track-offline-item')).toBeNull();
  });
});
