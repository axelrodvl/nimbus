import { Download, Home, Library, Search, Settings, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '@/lib/i18n/messages';

export type NavItem = { to: string; label: MessageKey; icon: LucideIcon; end?: boolean };

/** Все пункты навигации в порядке показа. Пункт виден, только если его маршрут зарегистрирован. */
export const NAV_ITEMS: readonly NavItem[] = [
  { end: true, icon: Home, label: 'nav.home', to: '/' },
  { icon: Search, label: 'nav.search', to: '/search' },
  { icon: Library, label: 'nav.library', to: '/library' },
  { icon: Download, label: 'nav.downloads', to: '/downloads' },
  { icon: Settings, label: 'nav.settings', to: '/settings' },
];

/** Зарегистрирован ли маршрут пункта: сам путь или любой вложенный (`/library/:tab`). */
export function hasRoute(paths: readonly string[], to: string): boolean {
  return paths.some(p => p === to || (to !== '/' && p.startsWith(`${to}/`)));
}

export function visibleNavItems(paths: readonly string[]): NavItem[] {
  return NAV_ITEMS.filter(item => hasRoute(paths, item.to));
}

/**
 * Куда ведёт призыв «найти музыку» на пустых экранах. Экран поиска появится в шаге 40 — тогда здесь `/search`;
 * до этого — библиотека.
 */
export const SEARCH_ENTRY = '/library';
