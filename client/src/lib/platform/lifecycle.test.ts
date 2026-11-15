import { describe, expect, it, vi } from 'vitest';
import { wireAppLifecycle, STALE_SOCKET_MS } from './app-lifecycle';
import { createLifecycle, type LifecycleTarget } from './lifecycle';
import { createWebHaptics, haptics, setHaptics } from './haptics';

class FakeTarget extends EventTarget implements LifecycleTarget {
  visibilityState = 'visible';
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
  hide() {
    this.visibilityState = 'hidden';
    this.fire('visibilitychange');
  }
  show() {
    this.visibilityState = 'visible';
    this.fire('visibilitychange');
  }
}

function setup() {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const lc = createLifecycle({ doc, win });
  return { doc, lc, win };
}

describe('lifecycle', () => {
  it('visibilitychange + pageshow + resume за один возврат — одно событие foreground', () => {
    const { doc, lc, win } = setup();
    const fg = vi.fn();
    const bg = vi.fn();
    lc.on('foreground', fg);
    lc.on('background', bg);
    doc.hide();
    win.fire('pagehide');
    expect(bg).toHaveBeenCalledTimes(1);
    doc.show();
    win.fire('pageshow');
    doc.fire('resume');
    expect(fg).toHaveBeenCalledTimes(1);
    expect(lc.isForeground()).toBe(true);
  });

  it('freeze → background, resume → foreground; pageshow из bfcache возвращает на передний план', () => {
    const { doc, lc, win } = setup();
    const events: string[] = [];
    lc.on('background', () => events.push('bg'));
    lc.on('foreground', () => events.push('fg'));
    doc.fire('freeze');
    doc.fire('resume');
    win.fire('pagehide');
    win.fire('pageshow');
    expect(events).toEqual(['bg', 'fg', 'bg', 'fg']);
  });

  it('online/offline проходят как есть; сбой подписчика не мешает остальным; отписка снимает слушатели', () => {
    const { lc, win } = setup();
    const online = vi.fn();
    const off = lc.on('online', () => {
      throw new Error('boom');
    });
    lc.on('online', online);
    win.fire('online');
    expect(online).toHaveBeenCalledTimes(1);
    off();
    win.fire('online');
    expect(online).toHaveBeenCalledTimes(2);
  });

  it('последняя отписка снимает браузерные слушатели', () => {
    const { doc, lc } = setup();
    const spy = vi.spyOn(doc, 'removeEventListener');
    lc.on('foreground', () => undefined)();
    expect(spy).toHaveBeenCalled();
  });
});

describe('wireAppLifecycle', () => {
  function wired(open = true) {
    const { doc, lc, win } = setup();
    let t = 1000;
    const deps = {
      flushOffline: vi.fn(),
      lifecycle: lc,
      now: () => t,
      persistPlayer: vi.fn(),
      reconcilePlayer: vi.fn(),
      socket: { isOpen: () => open, reconnect: vi.fn() },
    };
    wireAppLifecycle(deps);
    return { advance: (ms: number) => (t += ms), deps, doc, win };
  }

  it('pagehide сохраняет плеер и офлайн-очередь сразу', () => {
    const { deps, win } = wired();
    win.fire('pagehide');
    expect(deps.persistPlayer).toHaveBeenCalledTimes(1);
    expect(deps.flushOffline).toHaveBeenCalledTimes(1);
  });

  it('возврат из фона: переподключение сокета и сверка плеера — ровно по одному разу', () => {
    const { advance, deps, doc, win } = wired(false);
    doc.hide();
    advance(5000);
    doc.show();
    win.fire('pageshow');
    expect(deps.socket.reconnect).toHaveBeenCalledTimes(1);
    expect(deps.reconcilePlayer).toHaveBeenCalledTimes(1);
  });

  it('короткий уход в фон при живом сокете — без переподключения; долгий — с переподключением', () => {
    const { advance, deps, doc } = wired(true);
    doc.hide();
    advance(1000);
    doc.show();
    expect(deps.socket.reconnect).not.toHaveBeenCalled();
    doc.hide();
    advance(STALE_SOCKET_MS + 1);
    doc.show();
    expect(deps.socket.reconnect).toHaveBeenCalledTimes(1);
    expect(deps.reconcilePlayer).toHaveBeenCalledTimes(2);
  });
});

describe('haptics', () => {
  it('без navigator.vibrate тихо ничего не делает', () => {
    expect(() => createWebHaptics({}).impact('tap')).not.toThrow();
    expect(() => createWebHaptics(undefined).impact('select')).not.toThrow();
  });

  it('вызывает vibrate; исключение API проглатывается', () => {
    const vibrate = vi.fn(() => true);
    createWebHaptics({ vibrate }).impact('tap');
    expect(vibrate).toHaveBeenCalledWith(15);
    expect(() =>
      createWebHaptics({
        vibrate: () => {
          throw new Error('no gesture');
        },
      }).impact('tap'),
    ).not.toThrow();
  });

  it('подмена реализации (нативная оболочка)', () => {
    const impact = vi.fn();
    setHaptics({ impact });
    haptics().impact('select');
    expect(impact).toHaveBeenCalledWith('select');
    setHaptics(null);
  });
});
