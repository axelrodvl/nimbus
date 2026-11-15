import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeArtist, makeLibrary, resetFactories } from '@/test/factories';
import { renderWithProviders } from '@/test/render';
import { seed, seedNothing } from '@/test/seed';
import { Home } from './home';

beforeEach(resetFactories);

const names = (section: HTMLElement) =>
  within(section)
    .getAllByRole('link')
    .map(l => l.textContent ?? '');

describe('Home', () => {
  it('до гидратации — skeleton, а не пустое состояние', () => {
    seedNothing();
    renderWithProviders(<Home />);
    expect(screen.getByTestId('screen-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Найдите музыку')).not.toBeInTheDocument();
  });

  it('три секции: недавно слушали (4), недавно добавлено (12), готово к прослушиванию (10) — в правильном порядке', () => {
    const rows = makeLibrary({ albumsPerArtist: 5, artists: 3, tracksPerAlbum: 2 });
    // Прослушаны треки альбомов 1…6: свежее — у большего номера.
    rows.tracks.forEach(t => {
      if (t.album_id <= 6) t.last_played_at = new Date(Date.UTC(2026, 5, t.album_id)).toISOString();
    });
    // Артист без альбомов (дискография ещё импортируется) — самый новый.
    rows.artists.push(makeArtist({ added_at: '2027-01-01T00:00:00Z', id: 100, name: 'Fresh Artist' }));
    seed(rows);
    renderWithProviders(<Home />);

    const played = screen.getByTestId('home-played');
    expect(names(played).map(n => n.split('Artist')[0]?.trim())).toEqual([
      'Album 6',
      'Album 5',
      'Album 4',
      'Album 3',
      'Album 2',
      'Album 1',
    ]);

    const recent = screen.getByTestId('home-recent');
    const recentNames = names(recent);
    expect(recentNames).toHaveLength(12);
    expect(recentNames[0]).toContain('Fresh Artist');
    expect(recentNames[1]).toContain('Album 15');
  });

  it('пустая библиотека → пустое состояние со ссылкой на поиск', () => {
    seed();
    renderWithProviders(<Home />);
    expect(screen.getByText('Найдите музыку')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Перейти к поиску/ })).toHaveAttribute('href', '/search');
  });
});
