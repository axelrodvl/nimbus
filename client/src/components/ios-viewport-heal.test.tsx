import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IosViewportHeal } from './ios-viewport-heal';

const media = (matches: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener() {},
    matches,
    media: query,
    removeEventListener() {},
  }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
});
afterEach(() => vi.useRealTimers());

describe('IosViewportHeal', () => {
  it('в браузере (не standalone) ничего не делает', () => {
    media(false);
    render(<IosViewportHeal />);
    vi.advanceTimersByTime(5000);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('standalone: подталкивает прокрутку на 1px и возвращает, minHeight восстанавливается; события повторяют исцеление', () => {
    media(true);
    const { unmount } = render(<IosViewportHeal />);
    vi.advanceTimersByTime(0);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 1);
    vi.advanceTimersByTime(1);
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 0);
    expect(document.documentElement.style.minHeight).toBe('');
    vi.advanceTimersByTime(2000);
    const calls = vi.mocked(window.scrollTo).mock.calls.length;
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(200);
    expect(vi.mocked(window.scrollTo).mock.calls.length).toBeGreaterThan(calls);
    unmount();
    const after = vi.mocked(window.scrollTo).mock.calls.length;
    window.dispatchEvent(new Event('pageshow'));
    vi.advanceTimersByTime(500);
    expect(vi.mocked(window.scrollTo).mock.calls.length).toBe(after);
  });
});
