import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appData } from '@/lib/app-data';
import { addingStore, isInIndex, pendingAdds, type PendingAdd } from '@/lib/search/add';
import { LibraryScreen } from '@/screens/library/library';
import { Home } from '@/screens/home';
import { makeAlbum, makeArtist, makeTrack, resetFactories } from '@/test/factories';
import { mockLayout, ScrollHost } from '@/test/layout';
import { renderRoutes, renderWithProviders } from '@/test/render';
import { seed } from '@/test/seed';

const pending = (p: Partial<PendingAdd> & Pick<PendingAdd, 'mbid' | 'type'>): PendingAdd => ({
  at: 1,
  preview: { artistName: 'Pugacheva', cover: null, title: `Title ${p.mbid}` },
  ...p,
});
const start = (...items: PendingAdd[]) => act(() => items.forEach(i => addingStore.getState().start(i)));

let restore: () => void;
beforeEach(() => {
  resetFactories();
  restore = mockLayout({ height: 2000, width: 1000 });
});
afterEach(() => {
  restore();
  addingStore.setState({ adding: new Map() });
});

const emptyIndex = { albums: new Map(), artists: new Map(), tracks: new Map() };

describe('добавляемое (до прихода дельты)', () => {
  it('pendingAdds: новые сверху, фильтр по виду, уже пришедшее в store скрыто', () => {
    const adding = new Map(
      [
        pending({ at: 1, mbid: 'a', type: 'album' }),
        pending({ at: 3, mbid: 'b', type: 'artist' }),
        pending({ at: 2, mbid: 't', type: 'track' }),
      ].map(p => [p.mbid, p] as const),
    );
    expect(pendingAdds(adding, emptyIndex).map(p => p.mbid)).toEqual(['b', 't', 'a']);
    expect(pendingAdds(adding, emptyIndex, 'album').map(p => p.mbid)).toEqual(['a']);
    const index = { ...emptyIndex, artists: new Map([['b', 1]]) };
    expect(pendingAdds(adding, index).map(p => p.mbid)).toEqual(['t', 'a']);
    expect(
      isInIndex({ mbid: 't', type: 'track' }, { ...emptyIndex, tracks: new Map([['t', { albumId: 1, id: 1 }]]) }),
    ).toBe(true);
    expect(isInIndex({ mbid: 'a', type: 'album' }, emptyIndex)).toBe(false);
  });

  it('главная: сразу после «Добавить» — в «Недавно добавленных» (даже в пустой библиотеке); пришла дельта — настоящая карточка', async () => {
    seed();
    renderWithProviders(<Home />);
    expect(screen.queryByTestId('home-recent')).not.toBeInTheDocument();
    start(pending({ at: 2, mbid: 'ar-1', type: 'artist' }), pending({ at: 1, mbid: 'rg-1', type: 'album' }));
    const recent = screen.getByTestId('home-recent');
    const cards = within(recent).getAllByTestId('pending-add');
    expect(cards.map(c => c.getAttribute('data-type'))).toEqual(['artist', 'album']);
    expect(cards[0]).toHaveTextContent('Title ar-1');
    expect(cards[0]).toHaveTextContent('Добавляется…');
    expect(cards[1]).toHaveTextContent('Pugacheva');
    act(() =>
      appData()
        .library.getState()
        .applyBatch({
          albums: [makeAlbum({ artist_id: 1, id: 1, mbid: 'rg-1', title: 'Real Album' })],
          artists: [makeArtist({ id: 1, mbid: 'ar-1', name: 'Real Artist' })],
        }),
    );
    // Индекс mbid обновляется с троттлингом.
    await waitFor(() =>
      expect(within(screen.getByTestId('home-recent')).queryAllByTestId('pending-add')).toHaveLength(0),
    );
    expect(screen.getByTestId('home-recent')).toHaveTextContent('Real Album');
  });

  it('библиотека: добавляемое своего вида над списком; пустая библиотека не зовёт в поиск', async () => {
    seed({ albums: [], artists: [], tracks: [] });
    start(pending({ mbid: 'rg-1', type: 'album' }), pending({ mbid: 'rec-1', type: 'track' }));
    renderRoutes(
      [
        {
          element: (
            <ScrollHost>
              <LibraryScreen />
            </ScrollHost>
          ),
          path: '/library/:tab?',
        },
      ],
      '/library/albums',
    );
    const strip = screen.getByTestId('pending-strip');
    expect(
      within(strip)
        .getAllByTestId('pending-add')
        .map(c => c.getAttribute('data-type')),
    ).toEqual(['album']);
    expect(screen.queryByText('Перейти к поиску')).not.toBeInTheDocument();
    act(() =>
      appData()
        .library.getState()
        .applyBatch({
          albums: [makeAlbum({ artist_id: 1, id: 1, mbid: 'rg-1' })],
          artists: [makeArtist({ id: 1 })],
          tracks: [makeTrack({ album_id: 1, artist_id: 1, id: 1 })],
        }),
    );
    await waitFor(() => expect(screen.queryByTestId('pending-strip')).not.toBeInTheDocument());
  });
});
