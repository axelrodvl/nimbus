import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'nimbus:theme';
export const THEME_COLORS = { dark: '#121212', light: '#fafafa' } as const;
const DEFAULT_THEME: Theme = 'dark';

const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark' || v === 'system';

/** Сохранённая тема; без значения — тёмная (как в прежнем клиенте). */
export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

const query = () => globalThis.matchMedia('(prefers-color-scheme: dark)');

/** Тема, которая реально применяется: `system` раскрывается через `prefers-color-scheme`. */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return query().matches ? 'dark' : 'light';
  return theme;
}

/** Класс `dark` на `<html>` и `<meta name="theme-color">` (обе схемы получают один цвет — активной темы). */
export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => {
    meta.removeAttribute('media');
    meta.content = THEME_COLORS[resolved];
  });
}

const listeners = new Set<() => void>();
let current: Theme | null = null;
const notify = () => listeners.forEach(l => l());

/** Сохраняет и применяет тему. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Хранилище недоступно (приватный режим): тема действует до перезагрузки.
  }
  current = theme;
  applyTheme(theme);
  notify();
}

function snapshot(): Theme {
  return (current ??= readTheme());
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    globalThis.addEventListener('storage', onStorage);
    query().addEventListener('change', onSystemChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      globalThis.removeEventListener('storage', onStorage);
      query().removeEventListener('change', onSystemChange);
    }
  };
}

// Другая вкладка сменила тему.
function onStorage(e: StorageEvent) {
  if (e.key !== THEME_KEY && e.key !== null) return;
  current = readTheme();
  applyTheme(current);
  notify();
}

// Системная схема сменилась: имеет значение только в режиме `system`.
function onSystemChange() {
  if (snapshot() === 'system') applyTheme('system');
}

/** Сбрасывает кэш модуля (тесты). */
export function resetThemeCache(): void {
  current = null;
}

/** Текущая тема и её установка. */
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_THEME);
  return { setTheme, theme };
}
