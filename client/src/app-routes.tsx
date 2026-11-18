import type { RouteObject } from 'react-router';
import { DownloadsScreen, LegacyDownloadsRedirect } from '@/screens/downloads/downloads-screen';
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
  {
    lazy: async () => ({ Component: (await import('@/screens/rare-screens')).CatalogArtistScreen }),
    path: '/search/artist/:mbid',
  },
  {
    lazy: async () => ({ Component: (await import('@/screens/rare-screens')).CatalogAlbumScreen }),
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
