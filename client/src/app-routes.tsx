import type { RouteObject } from 'react-router';
import { Home } from '@/screens/home';

/**
 * Маршруты внутри оболочки. Экран добавляет свой шаг: запись здесь + при необходимости пункт в `NAV_ITEMS`.
 * Целевая таблица: `/library[/:tab]`, `/artist/:id`, `/album/:id` (39), `/search` (40),
 * `/album/:id/sources`, `/playlist/:id` (42), `/settings[/:section]` (43), `/downloads[/:tab]` (44).
 */
export const appRoutes: RouteObject[] = [{ element: <Home />, path: '/' }];

/** Пути зарегистрированных маршрутов — по ним оболочка решает, какие пункты навигации показывать. */
export const registeredPaths: string[] = appRoutes.flatMap(r => (r.path ? [r.path] : []));
