import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, readTheme, resetThemeCache, resolveTheme, setTheme, THEME_KEY, useTheme } from './theme';

type Listener = () => void;
let systemDark = false;
const mqListeners = new Set<Listener>();

function mockMatchMedia() {
  vi.stubGlobal('matchMedia', () => ({
    addEventListener: (_: string, l: Listener) => mqListeners.add(l),
    get matches() {
      return systemDark;
    },
    removeEventListener: (_: string, l: Listener) => mqListeners.delete(l),
  }));
}

function Probe() {
  const { theme } = useTheme();
  return <output>{theme}</output>;
}

beforeEach(() => {
  systemDark = false;
  mqListeners.clear();
  resetThemeCache();
  mockMatchMedia();
  document.head.innerHTML =
    '<meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)">';
});

describe('тема', () => {
  it('начальное значение берётся из localStorage', () => {
    localStorage.setItem(THEME_KEY, 'light');
    render(<Probe />);
    expect(screen.getByRole('status')).toHaveTextContent('light');
  });

  it('без сохранённого значения — тёмная; мусор в хранилище игнорируется', () => {
    expect(readTheme()).toBe('dark');
    localStorage.setItem(THEME_KEY, 'neon');
    expect(readTheme()).toBe('dark');
  });

  it('смена пишет в localStorage, ставит класс и цвет theme-color', () => {
    render(<Probe />);
    act(() => setTheme('light'));
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(screen.getByRole('status')).toHaveTextContent('light');
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    expect(metas.map(m => m.content)).toEqual(['#fafafa', '#fafafa']);
    expect(metas.every(m => !m.hasAttribute('media'))).toBe(true);
    act(() => setTheme('dark'));
    expect(document.documentElement).toHaveClass('dark');
    expect(metas[0]?.content).toBe('#121212');
  });

  it('system следует за matchMedia', () => {
    render(<Probe />);
    act(() => setTheme('system'));
    expect(document.documentElement).not.toHaveClass('dark');
    systemDark = true;
    act(() => mqListeners.forEach(l => l()));
    expect(document.documentElement).toHaveClass('dark');
    expect(resolveTheme('system')).toBe('dark');
  });

  it('смена системной схемы не трогает явно выбранную тему', () => {
    render(<Probe />);
    act(() => setTheme('light'));
    systemDark = true;
    act(() => mqListeners.forEach(l => l()));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('синхронизируется между вкладками через событие storage', () => {
    render(<Probe />);
    localStorage.setItem(THEME_KEY, 'light');
    act(() => {
      globalThis.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'light' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('чужие ключи storage игнорируются', () => {
    render(<Probe />);
    act(() => setTheme('light'));
    localStorage.setItem(THEME_KEY, 'dark');
    act(() => {
      globalThis.dispatchEvent(new StorageEvent('storage', { key: 'other' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('light');
  });

  it('недоступное хранилище не ломает смену темы', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readTheme()).toBe('dark');
    expect(() => setTheme('light')).not.toThrow();
    expect(document.documentElement).not.toHaveClass('dark');
    spy.mockRestore();
    get.mockRestore();
  });

  it('отписка снимает слушатели окна и media query', () => {
    const { unmount } = render(<Probe />);
    expect(mqListeners.size).toBe(1);
    unmount();
    expect(mqListeners.size).toBe(0);
  });

  it('applyTheme без meta не падает', () => {
    document.head.innerHTML = '';
    expect(() => applyTheme('dark')).not.toThrow();
  });
});
