import { describe, expect, it, vi } from 'vitest';
import { albumSubtitle, pickBestArtist } from '@/components/search/helpers';
import { addToLibraryRequest, searchRemote } from '@/lib/api/search';
import { createApiClient } from '@/lib/api/client';
import { en } from '@/lib/i18n/messages/en';
import { translate } from '@/lib/i18n/translate';
import { type MbidIndex, type SearchResult } from '@/lib/store/selectors';
import { searchFixture } from '@/test/search';
import { buildPaletteItems, PALETTE_ALBUMS, type PaletteAction } from './palette-items';

const t = (key: string, params?: Record<string, string | number>) => translate(en as never, 'en', key, params);
const empty: SearchResult = { albums: [], artists: [], tracks: [] };
const noIndex: MbidIndex = { albums: new Map(), artists: new Map(), tracks: new Map() };
const actions: PaletteAction[] = [
  { id: 'go-library', label: 'nav.library', run: vi.fn() },
  { id: 'theme-dark', label: 'theme.dark', run: vi.fn() },
];

describe('buildPaletteItems', () => {
  it('без запроса — только действия; с запросом они уходят вниз и фильтруются', () => {
    const all = buildPaletteItems({ actions, index: noIndex, local: empty, query: '', remote: undefined, t });
    expect(all.map(i => i.id)).toEqual(['action-go-library', 'action-theme-dark']);
    const some = buildPaletteItems({ actions, index: noIndex, local: empty, query: 'LIBR', remote: undefined, t });
    expect(some.map(i => i.id)).toEqual(['action-go-library']);
    expect(some[0]?.run).toBe(actions[0]?.run);
  });

  it('результаты MusicBrainz: то, что уже в библиотеке, пропускается; лимиты на секцию; поля добавления', () => {
    const remote = searchFixture();
    const index: MbidIndex = {
      albums: new Map([[remote.albums[1]!.mbid, 4]]),
      artists: new Map(),
      tracks: new Map([[remote.tracks[1]!.mbid, { albumId: 4, id: 9 }]]),
    };
    const items = buildPaletteItems({ actions: [], index, local: empty, query: 'radio', remote, t });
    expect(items.filter(i => i.group === 'album').map(i => i.title)).toEqual(['OK Computer']);
    expect(items.filter(i => i.group === 'track').map(i => i.title)).not.toContain('Karma Police');
    expect(items.every(i => i.add && !i.href)).toBe(true);
    expect(items.find(i => i.group === 'track')?.add).toMatchObject({ type: 'track', albumMbid: expect.any(String) });
    expect(items.filter(i => i.group === 'album').length).toBeLessThanOrEqual(PALETTE_ALBUMS);
    expect(items.find(i => i.group === 'track')?.meta).toBe('6:27');
  });

  it('трек без длительности — без `meta`', () => {
    const remote = searchFixture();
    remote.tracks[0]!.duration_ms = null;
    const items = buildPaletteItems({ actions: [], index: noIndex, local: empty, query: 'x', remote, t });
    expect(items.find(i => i.group === 'track')?.meta).toBeUndefined();
  });

  it('локальные: у каждого своя ссылка', () => {
    const local: SearchResult = {
      albums: [{ artistName: 'A', cover_url: null, id: 2, title: 'Alb' } as never],
      artists: [{ id: 1, mbid: 'm', name: 'Art' } as never],
      tracks: [
        { albumTitle: 'Alb', album_id: 2, artistName: 'A', coverUrl: null, duration_ms: null, id: 3, title: 'Tr' } as never,
        { albumTitle: '', album_id: 2, artistName: '', coverUrl: null, duration_ms: 61_000, id: 4, title: 'Tr2' } as never,
      ],
    };
    const items = buildPaletteItems({ actions: [], index: noIndex, local, query: 'a', remote: undefined, t });
    expect(items.map(i => i.href)).toEqual(['/artist/1', '/album/2', '/album/2', '/album/2']);
    expect(items[2]?.meta).toBeUndefined();
    expect(items[3]).toMatchObject({ meta: '1:01', subtitle: 'Track' });
  });
});

describe('helpers', () => {
  it('albumSubtitle: пропускает пустые части', () => {
    const [album] = searchFixture().albums;
    expect(albumSubtitle(album!)).toBe('Radiohead · 1997 · Album');
    expect(albumSubtitle({ ...album!, primary_type: null, year: null })).toBe('Radiohead');
  });

  it('pickBestArtist: точное имя → исполнитель топового трека с названием-запросом → первый артист', () => {
    const data = searchFixture();
    expect(pickBestArtist(data)?.name).toBe('Radiohead');
    expect(pickBestArtist({ ...data, query: ' RADIO HEAD ' })?.name).toBe('Radio Head');
    const byTrack = { ...data, query: 'paranoid android' };
    expect(pickBestArtist(byTrack)?.mbid).toBe(data.tracks[0]!.artist_mbid);
    const noArtist = { ...byTrack, artists: [] };
    expect(pickBestArtist(noArtist)).toMatchObject({ name: 'Radiohead', library_id: null });
    expect(pickBestArtist({ ...data, artists: [], query: 'zz', tracks: [] })).toBeUndefined();
    expect(pickBestArtist({ ...data, query: 'zz' })?.name).toBe('Radiohead');
  });
});

describe('слой API поиска', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

  it('searchRemote: GET /api/search?q=, signal пробрасывается, ошибка — ApiError', async () => {
    const fetch = vi.fn(async (_req: RequestInfo | URL) => json(200, searchFixture()));
    const client = createApiClient({ baseUrl: 'http://x', fetch });
    const controller = new AbortController();
    const res = await searchRemote('radiohead', controller.signal, client);
    expect(res.query).toBe('radiohead');
    const request = fetch.mock.calls[0]![0] as Request;
    expect(request.url).toBe('http://x/api/search?q=radiohead');
    const failing = createApiClient({
      baseUrl: 'http://x',
      fetch: async () => json(400, { error: { code: 'bad_query', message: 'q' } }),
    });
    await expect(searchRemote('', undefined, failing)).rejects.toMatchObject({ code: 'bad_query', status: 400 });
  });

  it('addToLibraryRequest: тело для артиста/альбома и для трека', async () => {
    const bodies: unknown[] = [];
    const client = createApiClient({
      baseUrl: 'http://x',
      fetch: async (req: RequestInfo | URL) => {
        bodies.push(await (req as Request).json());
        return json(201, { id: 1, status: 'added', type: 'album' });
      },
    });
    await addToLibraryRequest({ mbid: 'a', type: 'album' }, client);
    await addToLibraryRequest({ albumMbid: 'rg', mbid: 't', type: 'track' }, client);
    await addToLibraryRequest({ mbid: 't2', type: 'track' }, client);
    expect(bodies).toEqual([
      { mbid: 'a', type: 'album' },
      { album_mbid: 'rg', mbid: 't', type: 'track' },
      { album_mbid: null, mbid: 't2', type: 'track' },
    ]);
  });
});
