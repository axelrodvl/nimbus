import type { RouteObject } from 'react-router';
import { Home } from '@/screens/home';
import { AlbumScreen } from '@/screens/library/album';
import { ArtistScreen } from '@/screens/library/artist';
import { LibraryScreen } from '@/screens/library/library';
import { SourcesScreen } from '@/screens/library/sources';
import { PlaylistScreen } from '@/screens/playlist';
import { SearchScreen } from '@/screens/search';
import { SettingsScreen } from '@/screens/settings/settings-screen';

/**
 * Маршруты внутри оболочки. Экран добавляет свой шаг: запись здесь + при необходимости пункт в `NAV_ITEMS`.
 * Целевая таблица: `/library[/:tab]`, `/artist/:id`, `/album/:id` (39), `/search` (40, готов),
 * `/album/:id/sources`, `/playlist/:id` (42, готово), `/settings[/:section]` (43, готово), `/downloads[/:tab]` (44).
 */
const galleryEnabled = import.meta.env.DEV || import.meta.env.VITE_UI_GALLERY === '1';

export const appRoutes: RouteObject[] = [
  { element: <Home />, path: '/' },
  { element: <LibraryScreen />, path: '/library/:tab?' },
  { element: <ArtistScreen />, path: '/artist/:id' },
  { element: <AlbumScreen />, path: '/album/:id' },
  { element: <SourcesScreen />, path: '/album/:id/sources' },
  { element: <PlaylistScreen />, path: '/playlist/:id' },
  { element: <SearchScreen />, path: '/search' },
  { element: <SettingsScreen />, path: '/settings/:section?' },
  // Галерея примитивов: только dev и e2e-сборка (`VITE_UI_GALLERY=1`); в обычную сборку не попадает.
  ...(galleryEnabled
    ? [{ lazy: async () => ({ Component: (await import('@/screens/dev-ui')).DevUi }), path: '/dev/ui' }]
    : []),
];

/** Пути зарегистрированных маршрутов — по ним оболочка решает, какие пункты навигации показывать. */
export const registeredPaths: string[] = appRoutes.flatMap(r => (r.path ? [r.path] : []));
