import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlbumCard } from '@/components/library/album-card';
import { appData } from '@/lib/app-data';
import { resetPlayer } from '@/lib/player';
import { installTestPlayer, seedPlayerLibrary } from '@/test/player-ui';
import { renderWithProviders } from '@/test/render';
import { PlayAlbumButton, PlayableTrackRow, PlayTracksButton } from './play-buttons';
import { useAlbumTracks, useAlbumView } from '@/lib/store/hooks';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => true }));

const IDS = [10, 11, 12, 13];

function Rows({ ids = IDS }: { ids?: number[] }) {
  return (
    <ul>
      {ids.map(id => (
        <li key={id}>
          <PlayableTrackRow id={id} queueIds={IDS} />
        </li>
      ))}
    </ul>
  );
}

const row = (id: number) => document.querySelector(`[data-track-id="${id}"]`) as HTMLElement;

beforeEach(() => seedPlayerLibrary());
afterEach(() => resetPlayer(true));

describe('PlayableTrackRow', () => {
  it('кнопка запускает трек в контексте списка: очередь — доступные треки списка, старт с этого', async () => {
    const env = installTestPlayer();
    renderWithProviders(<Rows />);
    await userEvent.click(within(row(11)).getByRole('button', { name: 'Играть: Song Two' }));
    expect(env.ctl.state.queue.map(t => t.id)).toEqual([10, 11, 13]); // «Not Yet» (adding) не попал
    expect(env.ctl.state.queue[env.ctl.state.index].id).toBe(11);
    expect(env.engine.lastLoad?.src.url).toBe('/api/tracks/11/stream');
  });

  it('играющий трек: пауза по кнопке, подсветка строки, эквалайзер; на паузе — продолжить', async () => {
    const env = installTestPlayer();
    renderWithProviders(<Rows />);
    await userEvent.click(within(row(10)).getByTestId('play-track'));
    expect(row(10)).toHaveAttribute('data-current', 'true');
    expect(row(11)).not.toHaveAttribute('data-current');
    const btn = within(row(10)).getByTestId('play-track');
    expect(btn).toHaveAttribute('data-playing', 'true');
    expect(btn).toHaveAccessibleName('Пауза: Song One');
    await userEvent.click(btn);
    expect(env.engine.paused).toBe(true);
    act(() => env.engine.emit({ type: 'paused' }));
    expect(btn).toHaveAccessibleName('Играть: Song One');
    await userEvent.click(btn);
    expect(env.engine.playCalls).toBe(1); // продолжение, а не перезапуск
    expect(env.engine.loads).toHaveLength(1);
  });

  it('недоступный трек приглушён, кнопка заблокирована, строка не запускается', () => {
    const env = installTestPlayer();
    renderWithProviders(<Rows />);
    expect(within(row(12)).getByTestId('play-track')).toBeDisabled();
    expect(row(12)).toHaveClass('opacity-55');
    fireEvent.click(row(12));
    expect(env.engine.loads).toEqual([]);
    expect(row(12)).not.toHaveAttribute('tabindex');
  });

  it('клик и Enter по строке запускают трек', async () => {
    const env = installTestPlayer();
    renderWithProviders(<Rows />);
    fireEvent.click(row(13));
    expect(env.ctl.state.queue[env.ctl.state.index].id).toBe(13);
    row(10).focus();
    await userEvent.keyboard('{Enter}');
    expect(env.ctl.state.queue[env.ctl.state.index].id).toBe(10);
    // Enter на вложенной ссылке строку не запускает
    const before = env.engine.loads.length;
    fireEvent.keyDown(within(row(11)).getByRole('link', { name: 'Art' }), { key: 'Enter' });
    expect(env.engine.loads.length).toBe(before);
  });

  it('пункт меню «…» в портале не запускает трек строки', async () => {
    const env = installTestPlayer();
    renderWithProviders(<Rows />);
    await userEvent.click(within(row(10)).getByTestId('track-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: /плейлист/i }));
    expect(env.engine.loads.length).toBe(0);
  });

  it('статус трека обновляется вживую: стал доступным — можно запускать', () => {
    installTestPlayer();
    renderWithProviders(<Rows />);
    expect(within(row(12)).getByTestId('play-track')).toBeDisabled();
    act(() => appData().library.getState().patchTrack(12, { status: 'found' }));
    expect(within(row(12)).getByTestId('play-track')).toBeEnabled();
  });

  it('трек, которого нет в библиотеке, не рисуется', () => {
    installTestPlayer();
    renderWithProviders(<Rows ids={[999]} />);
    expect(document.querySelector('[data-track-id]')).toBeNull();
  });
});

function AlbumButtons() {
  const album = useAlbumView(2)!;
  const tracks = useAlbumTracks(2);
  return (
    <>
      <PlayAlbumButton albumId={2} />
      <PlayTracksButton label="Слушать всё" testId="play-all" tracks={tracks.slice(2, 3)} />
      <AlbumCard actions={<PlayAlbumButton albumId={2} variant="icon" />} album={album} />
    </>
  );
}

describe('PlayAlbumButton / PlayTracksButton', () => {
  it('«Слушать альбом»: очередь из доступных треков по порядку, пауза/продолжить', async () => {
    const env = installTestPlayer();
    renderWithProviders(<AlbumButtons />);
    const pill = screen.getByTestId('play-album');
    expect(pill).toHaveTextContent('Слушать альбом');
    await userEvent.click(pill);
    expect(env.ctl.state.queue.map(t => t.id)).toEqual([10, 11, 13]);
    expect(env.ctl.state.index).toBe(0);
    expect(pill).toHaveTextContent('Пауза');
    expect(pill).toHaveAttribute('data-playing', 'true');
    await userEvent.click(pill);
    expect(env.engine.paused).toBe(true);
    act(() => env.engine.emit({ type: 'paused' }));
    expect(pill).toHaveTextContent('Слушать альбом');
    await userEvent.click(pill);
    expect(env.engine.loads).toHaveLength(1);
    expect(env.engine.playCalls).toBe(1);
  });

  it('круглая кнопка на карточке альбома делает то же самое', async () => {
    const env = installTestPlayer();
    renderWithProviders(<AlbumButtons />);
    const icon = screen.getByTestId('play-album-card');
    await userEvent.click(icon);
    expect(env.ctl.state.queue.map(t => t.id)).toEqual([10, 11, 13]);
    expect(icon).toHaveAttribute('data-playing', 'true');
  });

  it('нет доступных треков — кнопка заблокирована с подсказкой', () => {
    installTestPlayer();
    renderWithProviders(<AlbumButtons />);
    // «Слушать всё» — только трек 12 (adding)
    const disabled = screen.getByRole('button', { name: 'Слушать всё' });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveAttribute('title', 'Пока нет треков, которые можно слушать');
  });

  it('когда играет трек другого альбома, кнопка начинает свою очередь', async () => {
    const env = installTestPlayer();
    renderWithProviders(<AlbumButtons />);
    act(() => env.ctl.play({ ...env.ctl.state.queue[0], id: 500, status: 'found', title: 'Other' } as never));
    await userEvent.click(screen.getByTestId('play-album'));
    expect(env.ctl.state.queue.map(t => t.id)).toEqual([10, 11, 13]);
  });
});
