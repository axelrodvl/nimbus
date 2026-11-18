import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SPLASH_SIZES, SPLASH_THEMES, SPLASH_END, SPLASH_START, splashFile, splashLinks, withSplashLinks } from '../../../scripts/splash';
import { sheetOffset, sheetRelease, velocityOf } from '../gestures/sheet-drag';
import { scrollToTop, scrollRoot, SCROLL_ROOT_ATTR } from '../nav/scroll-top';
import { isAppleTouch, isStandalone } from './ios';
import { isKeyboardOpen, KEYBOARD_MIN_PX, watchKeyboard } from './keyboard';

const root = join(__dirname, '..', '..', '..');

describe('клавиатура', () => {
  it('открыта: видимая область заметно ниже окна и в фокусе поле ввода', () => {
    expect(isKeyboardOpen(800, 480, true)).toBe(true);
    expect(isKeyboardOpen(800, 480, false)).toBe(false);
    // Адресная строка Safari меняет высоту на малую величину — это не клавиатура.
    expect(isKeyboardOpen(800, 800 - KEYBOARD_MIN_PX + 1, true)).toBe(false);
  });

  it('watchKeyboard ставит data-keyboard и --vvh при уменьшении visualViewport и снимает при закрытии', () => {
    const vvTarget = new EventTarget();
    const vv = Object.assign(vvTarget, { height: 800 });
    const docTarget = new EventTarget();
    const props = new Map<string, string>();
    const root = {
      dataset: {} as DOMStringMap,
      style: { removeProperty: (k: string) => void props.delete(k), setProperty: (k: string, v: string) => void props.set(k, v) },
    };
    const doc = Object.assign(docTarget, { activeElement: { tagName: 'INPUT' } as Element, documentElement: root });
    const win = Object.assign(new EventTarget(), { innerHeight: 800, visualViewport: vv });
    const stop = watchKeyboard({ doc: doc as never, win: win as never });
    expect(root.dataset.keyboard).toBeUndefined();
    vv.height = 450;
    vvTarget.dispatchEvent(new Event('resize'));
    expect(root.dataset.keyboard).toBe('open');
    expect(props.get('--vvh')).toBe('450px');
    vv.height = 800;
    vvTarget.dispatchEvent(new Event('resize'));
    expect(root.dataset.keyboard).toBeUndefined();
    expect(props.has('--vvh')).toBe(false);
    stop();
  });

  it('без visualViewport — ничего не делает', () => {
    expect(() => watchKeyboard({ doc: {} as never, win: { visualViewport: null } as never })()).not.toThrow();
  });
});

describe('платформа Apple', () => {
  it('iPhone, iPad и iPadOS под видом Mac — да; Android и настольный Mac — нет', () => {
    expect(isAppleTouch({ maxTouchPoints: 5, platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })).toBe(true);
    expect(isAppleTouch({ maxTouchPoints: 5, platform: 'MacIntel', userAgent: 'Macintosh' })).toBe(true);
    expect(isAppleTouch({ maxTouchPoints: 0, platform: 'MacIntel', userAgent: 'Macintosh' })).toBe(false);
    expect(isAppleTouch({ maxTouchPoints: 5, platform: 'Linux armv8l', userAgent: 'Android 14; Pixel 7' })).toBe(false);
    expect(isAppleTouch(undefined)).toBe(false);
  });

  it('standalone: display-mode или navigator.standalone', () => {
    expect(isStandalone({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(isStandalone({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } })).toBe(true);
    expect(isStandalone({ matchMedia: () => ({ matches: false }) })).toBe(false);
  });
});

describe('нижний лист', () => {
  it('закрывается по пройденной доле высоты, по броску вниз; бросок вверх возвращает', () => {
    expect(sheetRelease(100, 0, 300)).toBe('close');
    expect(sheetRelease(40, 0, 300)).toBe('snap');
    expect(sheetRelease(20, 0.8, 300)).toBe('close'); // инерция
    expect(sheetRelease(150, -0.9, 300)).toBe('snap');
    expect(sheetRelease(0, 0, 0)).toBe('snap');
  });

  it('за верхнюю точку лист идёт «резиной»; скорость считается по двум точкам', () => {
    expect(sheetOffset(60)).toBe(60);
    expect(sheetOffset(-60)).toBe(-10);
    expect(velocityOf(0, 0, 50, 100)).toBe(0.5);
    expect(velocityOf(0, 10, 50, 10)).toBe(0);
  });
});

describe('повторное нажатие на вкладку', () => {
  it('прокручивает контейнер к началу, только если он не вверху; reduced motion — без плавности', () => {
    const el = document.createElement('main');
    el.setAttribute(SCROLL_ROOT_ATTR, '');
    document.body.append(el);
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as never;
    expect(scrollRoot()).toBe(el);
    expect(scrollToTop(el, false)).toBe(false);
    el.scrollTop = 500;
    expect(scrollToTop(el, false)).toBe(true);
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: 'smooth', top: 0 });
    scrollToTop(el, true);
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: 'auto', top: 0 });
    expect(scrollToTop(null, false)).toBe(false);
    el.remove();
  });
});

describe('заставки iOS', () => {
  it('index.html содержит актуальный блок ссылок, PNG на месте для обеих тем', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain(splashLinks());
    expect(withSplashLinks(html)).toBe(html);
    for (const theme of Object.keys(SPLASH_THEMES) as (keyof typeof SPLASH_THEMES)[]) {
      for (const size of SPLASH_SIZES) {
        expect(existsSync(join(root, 'public', splashFile(size, theme)))).toBe(true);
      }
    }
    expect(html.indexOf(SPLASH_START)).toBeLessThan(html.indexOf(SPLASH_END));
  });

  it('withSplashLinks без маркеров — ошибка', () => {
    expect(() => withSplashLinks('<html></html>')).toThrow();
  });
});

describe('запуск без белой вспышки', () => {
  it('фон html в index.html и background_color манифеста совпадают с темой', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const vite = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    expect(html).toMatch(/html \{\s*background: #121212;/);
    expect(html).toMatch(/html:not\(\.dark\) \{\s*background: #fafafa;/);
    expect(vite).toContain("background_color: '#121212'");
    expect(vite).toContain("display_override: ['standalone']");
    expect(html).toContain('interactive-widget=resizes-content');
  });
});

describe('обложка Media Session без сети', () => {
  it('нет в кэше → логотип; есть в кэше → обложка остаётся', async () => {
    const { createMediaSession } = await import('../player/media-session');
    const { FakeMediaMetadata, FakeMediaSession } = await import('@/test/fake-audio');
    vi.stubGlobal('MediaMetadata', FakeMediaMetadata);
    vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: false });
    const meta = { album: 'A', artist: 'B', coverUrl: '/cover.jpg', durationS: 1, title: 'T' };
    for (const cached of [false, true]) {
      vi.stubGlobal('caches', { match: vi.fn(async () => (cached ? {} : undefined)) });
      const session = new FakeMediaSession();
      createMediaSession(() => undefined, session.asSession()).setMetadata(meta);
      await vi.waitFor(() => expect(globalThis.caches.match).toHaveBeenCalled());
      await Promise.resolve();
      const src = (session.metadata as { artwork: { src: string }[] }).artwork[0]!.src;
      expect(src).toBe(cached ? '/cover.jpg' : '/icons/icon-512.png');
    }
    vi.unstubAllGlobals();
  });
});

describe('toast об очистке хранилища системой', () => {
  it('показывается один раз за сессию', async () => {
    const warning = vi.fn();
    vi.doMock('sonner', () => ({ toast: { warning } }));
    vi.resetModules();
    const { notifyStorageCleared } = await import('../offline');
    notifyStorageCleared();
    notifyStorageCleared();
    expect(warning).toHaveBeenCalledTimes(1);
    vi.doUnmock('sonner');
  });
});
