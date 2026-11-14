import type { RouteObject } from 'react-router';
import { Home } from '@/screens/home';
import { AlbumScreen } from '@/screens/library/album';
import { ArtistScreen } from '@/screens/library/artist';
import { LibraryScreen } from '@/screens/library/library';
import { SearchScreen } from '@/screens/search';

/**
 * Маршруты внутри оболочки. Экран добавляет свой шаг: запись здесь + при необходимости пункт в `NAV_ITEMS`.
 * Целевая таблица: `/library[/:tab]`, `/artist/:id`, `/album/:id` (39), `/search` (40, готов),
 * `/album/:id/sources`, `/playlist/:id` (42), `/settings[/:section]` (43), `/downloads[/:tab]` (44).
 */
export const appRoutes: RouteObject[] = [
  { element: <Home />, path: '/' },
  { element: <LibraryScreen />, path: '/library/:tab?' },
  { element: <ArtistScreen />, path: '/artist/:id' },
  { element: <AlbumScreen />, path: '/album/:id' },
  { element: <SearchScreen />, path: '/search' },
];

/** Пути зарегистрированных маршрутов — по ним оболочка решает, какие пункты навигации показывать. */
export const registeredPaths: string[] = appRoutes.flatMap(r => (r.path ? [r.path] : []));
