import * as Ariakit from '@ariakit/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ui/dialog';
import { MenuSheet } from '@/components/ui/menu-sheet';
import { MobileTabBar } from '@/components/mobile-tab-bar';
import { NAV_ITEMS } from '@/lib/nav/items';
import { SCROLL_ROOT_ATTR } from '@/lib/nav/scroll-top';
import { renderWithProviders } from '@/test/render';
import { EdgeSwipeBack } from './edge-swipe-back';

function stubMobile(width = true) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    addEventListener() {},
    matches: q.includes('max-width: 639px') ? width : false,
    removeEventListener() {},
  }));
}
afterEach(() => vi.unstubAllGlobals());

function SheetHarness() {
  const store = Ariakit.useDialogStore({ defaultOpen: true });
  return (
    <Dialog store={store} title="Лист" variant="sheet">
      <p>внутри</p>
    </Dialog>
  );
}

function MenuHarness() {
  return (
    <Ariakit.MenuProvider defaultOpen>
      <MenuSheet>
        <Ariakit.MenuItem>Пункт</Ariakit.MenuItem>
      </MenuSheet>
    </Ariakit.MenuProvider>
  );
}

const drag = (handle: HTMLElement, to: number, dt = 400) => {
  fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1, timeStamp: 0 });
  fireEvent.pointerMove(handle, { clientY: to, pointerId: 1, timeStamp: dt });
  fireEvent.pointerUp(handle, { clientY: to, pointerId: 1, timeStamp: dt });
};

describe('нижние листы', () => {
  beforeEach(() => stubMobile(true));

  it('диалог-лист на мобильной ширине: ручка видна; бросок вниз закрывает', async () => {
    render(<SheetHarness />);
    const handle = await screen.findByTestId('sheet-handle');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1, timeStamp: 0 });
    fireEvent.pointerMove(handle, { clientY: 160, pointerId: 1, timeStamp: 50 });
    fireEvent.pointerUp(handle, { clientY: 160, pointerId: 1, timeStamp: 50 });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('короткое медленное перетаскивание возвращает лист на место; pointercancel тоже', async () => {
    render(<SheetHarness />);
    const handle = await screen.findByTestId('sheet-handle');
    drag(handle, 105, 800);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Движение без нажатия — игнорируется.
    fireEvent.pointerMove(handle, { clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 500, pointerId: 1 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('на широком экране ручки нет', () => {
    stubMobile(false);
    render(<SheetHarness />);
    expect(screen.queryByTestId('sheet-handle')).not.toBeInTheDocument();
  });

  it('меню на мобильной ширине — лист (data-sheet) с ручкой; на широкой — обычное меню', async () => {
    const { unmount } = render(<MenuHarness />);
    expect((await screen.findByRole('menu')).getAttribute('data-sheet')).toBe('true');
    expect(screen.getByTestId('sheet-handle')).toBeInTheDocument();
    unmount();
    stubMobile(false);
    render(<MenuHarness />);
    expect((await screen.findByRole('menu')).getAttribute('data-sheet')).toBeNull();
  });
});

describe('вкладки', () => {
  it('повторное нажатие на активную вкладку прокручивает экран к началу, на другую — нет', () => {
    vi.stubGlobal('matchMedia', () => ({ addEventListener() {}, matches: false, removeEventListener() {} }));
    const main = document.createElement('main');
    main.setAttribute(SCROLL_ROOT_ATTR, '');
    main.scrollTo = vi.fn() as never;
    main.scrollTop = 300;
    document.body.append(main);
    const items = NAV_ITEMS.slice(0, 2);
    renderWithProviders(<MobileTabBar items={items} />, { route: items[0]!.to });
    const links = screen.getAllByRole('link');
    fireEvent.click(links[1]!);
    expect(main.scrollTo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { current: 'page' }));
    expect(main.scrollTo).toHaveBeenCalledWith({ behavior: 'smooth', top: 0 });
    main.remove();
  });
});

describe('смахивание назад', () => {
  function setup(opts: { standalone: boolean }) {
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      maxTouchPoints: 5,
      platform: 'iPhone',
      standalone: opts.standalone,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
    });
    vi.stubGlobal('matchMedia', () => ({ addEventListener() {}, matches: false, removeEventListener() {} }));
    const main = document.createElement('main');
    main.setAttribute(SCROLL_ROOT_ATTR, '');
    const parent = document.createElement('div');
    parent.append(main);
    document.body.append(parent);
    const router = createMemoryRouter(
      [
        { element: <p>первая</p>, path: '/a' },
        { element: <EdgeSwipeBack />, path: '/b' },
      ],
      { initialEntries: ['/a', '/b'], initialIndex: 1 },
    );
    render(<RouterProvider router={router} />);
    return { parent, router };
  }
  const touch = (type: string, x: number, y: number, t: number) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] });
    Object.defineProperty(ev, 'timeStamp', { value: t });
    act(() => void document.dispatchEvent(ev));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(history, 'state', { configurable: true, value: { idx: 1 } });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    Reflect.deleteProperty(history, 'state');
  });

  it('вне standalone жест выключен', () => {
    const { router } = setup({ standalone: false });
    touch('touchstart', 4, 300, 0);
    touch('touchmove', 150, 300, 50);
    touch('touchend', 150, 300, 60);
    act(() => void vi.advanceTimersByTime(500));
    expect(router.state.location.pathname).toBe('/b');
  });

  it('от края до порога — экран едет за пальцем, затем возврат назад', () => {
    const { parent, router } = setup({ standalone: true });
    touch('touchstart', 4, 300, 0);
    touch('touchmove', 60, 302, 40);
    touch('touchmove', 140, 304, 80);
    expect(parent.style.translate).toBe('136px 0');
    touch('touchend', 140, 304, 90);
    act(() => void vi.advanceTimersByTime(300));
    expect(router.state.location.pathname).toBe('/a');
    expect(parent.style.translate).toBe('');
  });

  it('недотянули — экран возвращается на место, навигации нет', () => {
    const { parent, router } = setup({ standalone: true });
    touch('touchstart', 4, 300, 0);
    touch('touchmove', 30, 300, 500);
    touch('touchmove', 50, 300, 1000);
    touch('touchend', 50, 300, 1010);
    expect(parent.style.translate).toBe('');
    act(() => void vi.advanceTimersByTime(500));
    expect(router.state.location.pathname).toBe('/b');
  });

  it('нет истории (idx = 0) или открыт диалог — жест не начинается', () => {
    Object.defineProperty(history, 'state', { configurable: true, value: { idx: 0 } });
    const { router } = setup({ standalone: true });
    touch('touchstart', 4, 300, 0);
    touch('touchmove', 150, 300, 50);
    touch('touchend', 150, 300, 60);
    Object.defineProperty(history, 'state', { configurable: true, value: { idx: 1 } });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    touch('touchstart', 4, 300, 100);
    touch('touchmove', 150, 300, 150);
    touch('touchend', 150, 300, 160);
    act(() => void vi.advanceTimersByTime(500));
    expect(router.state.location.pathname).toBe('/b');
  });
});
