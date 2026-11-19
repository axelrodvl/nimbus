import type { RouteObject } from 'react-router';
import { DownloadsScreen, LegacyDownloadsRedirect } from '@/screens/downloads/downloads-screen';
import { queryClient } from '@/lib/query/client';
import { Home } from '@/screens/home';
import { AlbumScreen } from '@/screens/library/album';
import { ArtistScreen } from '@/screens/library/artist';
import { LibraryScreen } from '@/screens/library/library';
import { PlaylistScreen } from '@/screens/playlist';
import { SettingsScreen } from '@/screens/settings/settings-screen';

/**
 * Маршруты внутри оболочки. Экран добавляет свой шаг: запись здесь + при необходимости пункт в `NAV_ITEMS`.
 * Целевая таблица: `/library[/:tab]`, `/artist/:id`, `/album/:id` (39), `/search` (40, готов),
 * `/album/:id/sources`, `/playlist/:id` (42, готово), `/settings[/:section]` (43, готово), `/downloads[/:tab]` (44, готово).
 */
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loader экрана каталога: неверный `:mbid` не запрашивается (экран покажет «нет в MusicBrainz»). */
async function preload(
  fn: (client: typeof queryClient, kind: 'artist' | 'album', mbid: string) => Promise<void>,
  kind: 'artist' | 'album',
  mbid: string | undefined,
): Promise<null> {
  if (mbid && MBID.test(mbid)) await fn(queryClient, kind, mbid);
  return null;
}

const galleryEnabled = import.meta.env.DEV || import.meta.env.VITE_UI_GALLERY === '1';

export const appRoutes: RouteObject[] = [
  { element: <Home />, path: '/' },
  { element: <LibraryScreen />, path: '/library/:tab?' },
  { element: <ArtistScreen />, path: '/artist/:id' },
  { element: <AlbumScreen />, path: '/album/:id' },
  // Редкий экран — отдельным чанком (бюджет начального JS); чанк в precache PWA, офлайн открывается так же.
  {
    lazy: async () => ({ Component: (await import('@/screens/rare-screens')).SourcesScreen }),
    path: '/album/:id/sources',
  },
  { element: <PlaylistScreen />, path: '/playlist/:id' },
  // Поиск и каталог — тем же отдельным чанком (общие модули результатов и запуска трека); оболочка загружает его сразу
  // после старта (`usePreloadRareScreens`), так что первое нажатие на «Поиск» не ждёт кода.
  { lazy: async () => ({ Component: (await import('@/screens/rare-screens')).SearchScreen }), path: '/search' },
  // Каталог MusicBrainz: артист и альбом из поиска, которых может не быть в библиотеке.
  // Тем же отдельным чанком: открывается по нажатию на результат поиска, и только при сети.
  // Loader начинает запрос до перехода и коротко его ждёт (`preloadCatalog`): прежний экран остаётся на месте, пока
  // ответ не пришёл, — новый открывается сразу с данными, без вспышки skeleton.
  {
    lazy: async () => {
      const m = await import('@/screens/rare-screens');
      return {
        Component: m.CatalogArtistScreen,
        loader: async ({ params }) => preload(m.preloadCatalog, 'artist', params.mbid),
      };
    },
    path: '/search/artist/:mbid',
  },
  {
    lazy: async () => {
      const m = await import('@/screens/rare-screens');
      return {
        Component: m.CatalogAlbumScreen,
        loader: async ({ params }) => preload(m.preloadCatalog, 'album', params.mbid),
      };
    },
    path: '/search/album/:mbid',
  },
  { element: <DownloadsScreen />, path: '/downloads/:tab?' },
  // Статический маршрут приоритетнее `/settings/:section?`.
  { element: <LegacyDownloadsRedirect />, path: '/settings/downloads' },
  { element: <SettingsScreen />, path: '/settings/:section?' },
  // Галерея примитивов: только dev и e2e-сборка (`VITE_UI_GALLERY=1`); в обычную сборку не попадает.
  ...(galleryEnabled
    ? [{ lazy: async () => ({ Component: (await import('@/screens/dev-ui')).DevUi }), path: '/dev/ui' }]
    : []),
];

/** Пути зарегистрированных маршрутов — по ним оболочка решает, какие пункты навигации показывать. */
export const registeredPaths: string[] = appRoutes.flatMap(r => (r.path ? [r.path] : []));
