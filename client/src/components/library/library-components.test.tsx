import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeAlbum, makeTrack } from '@/test/factories';
import { renderWithProviders } from '@/test/render';
import { AlbumCard } from './album-card';
import { initials, ArtistAvatar } from './artist-avatar';
import { ArtistCard } from './artist-card';
import { AudioQuality } from './audio-quality';
import { Cover } from './cover';
import { StatusMiniBar } from './status-mini-bar';
import { TrackRow } from './track-row';

const MBID = '11111111-2222-3333-4444-555555555555';
const caa = `https://coverartarchive.org/release-group/${MBID}/front-250`;

describe('Cover', () => {
  it('ленивая загрузка и миниатюра нужного размера', () => {
    render(<Cover alt="A" src={caa} thumb={500} />);
    const img = screen.getByRole('img', { name: 'A' });
    expect(img).toHaveAttribute('src', `/api/covers/release-group/${MBID}/500`);
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(screen.getByTestId('cover')).toHaveClass('aspect-square');
  });

  it('пока крупная грузится — под ней малая миниатюра на нейтральном фоне, а не градиент заглушки', () => {
    render(<Cover alt="A" src={caa} thumb={500} />);
    const cover = screen.getByTestId('cover');
    const small = cover.querySelector('img[aria-hidden]');
    expect(small).toHaveAttribute('src', `/api/covers/release-group/${MBID}/250`);
    expect(cover).toHaveClass('bg-card');
    expect(cover.className).not.toContain('from-violet-500');
  });

  it('малая миниатюра сама по себе — без подложки', () => {
    render(<Cover alt="A" src={caa} />);
    expect(screen.getByTestId('cover').querySelectorAll('img')).toHaveLength(1);
  });

  it('над сгибом: eager и высокий приоритет', () => {
    render(<Cover alt="A" priority src={caa} />);
    const img = screen.getByRole('img', { name: 'A' });
    expect(img).toHaveAttribute('loading', 'eager');
    expect(img).toHaveAttribute('fetchpriority', 'high');
  });

  it('нет адреса или ошибка загрузки — заглушка с нотой', () => {
    const { unmount } = render(<Cover alt="A" src={null} />);
    expect(screen.queryByRole('img', { name: 'A' })).not.toBeInTheDocument();
    expect(screen.getByTestId('cover').querySelector('svg')).toBeInTheDocument();
    unmount();
    render(<Cover alt="B" src={caa} />);
    fireEvent.error(screen.getByRole('img', { name: 'B' }));
    expect(screen.queryByRole('img', { name: 'B' })).not.toBeInTheDocument();
    expect(screen.getByTestId('cover').querySelector('svg')).toBeInTheDocument();
  });
});

describe('ArtistAvatar', () => {
  it('фото с бэкенда; при ошибке — инициалы', () => {
    const { container } = render(<ArtistAvatar mbid="abcd-1234" name="Daft Punk" />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/artist-image/abcd-1234');
    expect(screen.getByText('DP')).toBeInTheDocument();
    // Под фото инициалы проявляются с задержкой — фото из кэша успевает раньше, без вспышки.
    expect(screen.getByText('DP').parentElement).toHaveClass('delayed-appear');
    fireEvent.error(img!);
    expect(screen.getByText('DP').parentElement).not.toHaveClass('delayed-appear');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('DP')).toBeInTheDocument();
  });

  it('инициалы: одно слово, два слова, пусто', () => {
    expect(initials('Radiohead')).toBe('R');
    expect(initials('Pink Floyd Band')).toBe('PF');
    expect(initials('  ')).toBe('?');
  });
});

describe('карточки', () => {
  const album = {
    ...makeAlbum({ id: 5, title: 'OK Computer', year: 1997 }),
    artistName: 'Radiohead',
    statusCounts: { adding: 0, found: 1, not_found: 0, ready: 1 },
    trackCount: 2,
  };

  it('AlbumCard: ссылка, название, мета, слот действий', () => {
    renderWithProviders(<AlbumCard actions={<button type="button">play</button>} album={album} priority />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/album/5');
    expect(link).toHaveTextContent('OK Computer');
    expect(link).toHaveTextContent('Radiohead · 1997 · Альбом');
    expect(screen.getByRole('button', { name: 'play' })).toBeInTheDocument();
  });

  it('AlbumCard: не целиком в библиотеке — пометка', () => {
    renderWithProviders(<AlbumCard album={{ ...album, in_library: false }} />);
    expect(screen.getByText('Добавлены отдельные треки')).toBeInTheDocument();
  });

  it('ArtistCard: счётчики; импорт — только если пусто', () => {
    const artist = { added_at: null, albumCount: 3, id: 2, in_library: true, mbid: 'm', name: 'Muse', trackCount: 30 };
    const { unmount } = renderWithProviders(<ArtistCard artist={artist} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/artist/2');
    expect(screen.getByText('3 альбома · 30 треков')).toBeInTheDocument();
    expect(screen.queryByTestId('artist-import-badge')).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<ArtistCard artist={{ ...artist, albumCount: 0, trackCount: 0 }} />);
    expect(screen.getByTestId('artist-import-badge')).toHaveTextContent('Импорт…');
  });
});

describe('TrackRow', () => {
  const track = {
    ...makeTrack({ album_id: 3, artist_id: 4, duration_ms: 185_000, id: 9, play_count: 7, title: 'Karma Police' }),
    albumTitle: 'OK Computer',
    artistName: 'Radiohead',
    coverUrl: null,
  };

  it('название, ссылки на артиста и альбом, время, счётчик, слоты', () => {
    renderWithProviders(
      <TrackRow actions={<i data-testid="act" />} leading={<i data-testid="lead" />} track={track} />,
    );
    expect(screen.getByText('Karma Police')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Radiohead' })).toHaveAttribute('href', '/artist/4');
    expect(screen.getByRole('link', { name: 'OK Computer' })).toHaveAttribute('href', '/album/3');
    expect(screen.getByText('3:05')).toBeInTheDocument();
    expect(screen.getByTestId('play-count')).toHaveTextContent('7');
    expect(screen.getByTestId('lead')).toBeInTheDocument();
    expect(screen.getByTestId('act')).toBeInTheDocument();
  });

  it('на странице альбома: номер вместо обложки, без ссылки на альбом', () => {
    renderWithProviders(<TrackRow index={4} showAlbum={false} track={{ ...track, play_count: 0 }} />);
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.queryByTestId('cover')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'OK Computer' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('play-count')).not.toBeInTheDocument();
  });

  it('трек вне библиотеки приглушён и без бейджа статуса; сомнительный источник — предупреждение', () => {
    const { unmount } = renderWithProviders(<TrackRow track={{ ...track, in_library: false }} />);
    expect(screen.getByTestId('track-row')).toHaveClass('opacity-55');
    expect(screen.queryByRole('img', { name: 'Скачано' })).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<TrackRow track={{ ...track, needs_confirmation: true }} />);
    expect(screen.getByTestId('needs-confirmation')).toBeInTheDocument();
  });
});

describe('StatusMiniBar и AudioQuality', () => {
  it('полоска статусов: пропорции и подпись; пустой альбом — ничего', () => {
    const counts = { adding: 1, found: 0, not_found: 0, ready: 3 };
    const { container, unmount } = renderWithProviders(<StatusMiniBar counts={counts} total={4} />);
    const bar = screen.getByRole('img');
    expect(bar).toHaveAttribute('aria-label', '3 скачано, 1 ищем');
    expect([...bar.children].map(c => (c as HTMLElement).style.width)).toEqual(['75%', '25%']);
    unmount();
    renderWithProviders(<StatusMiniBar counts={counts} total={0} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    void container;
  });

  it('AudioQuality занимает место и без данных', () => {
    const { rerender } = render(<AudioQuality info={null} />);
    expect(screen.getByTestId('audio-quality')).toHaveClass('h-4');
    expect(screen.getByTestId('audio-quality').firstElementChild).toHaveClass('opacity-0');
    rerender(<AudioQuality info={{ codec: 'flac', ext: 'flac', transcoded: false } as never} />);
    expect(screen.getByTestId('audio-quality')).toHaveTextContent('FLAC');
    expect(screen.getByTestId('audio-quality').firstElementChild).toHaveClass('opacity-100');
  });

  it('AudioQuality: данные прежнего трека остаются в DOM, но гаснут', () => {
    render(<AudioQuality info={{ codec: 'flac', ext: 'flac', transcoded: false } as never} stale />);
    expect(screen.getByTestId('audio-quality')).toHaveTextContent('FLAC');
    expect(screen.getByTestId('audio-quality').firstElementChild).toHaveClass('opacity-0');
  });
});
