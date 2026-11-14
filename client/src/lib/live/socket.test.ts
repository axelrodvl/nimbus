import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveSocket, SOCKET_MAX_DELAY_MS, type SocketLike } from './socket';

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  onclose: SocketLike['onclose'] = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

const last = (): FakeSocket => {
  const s = FakeSocket.all.at(-1);
  if (!s) throw new Error('no socket');
  return s;
};
const make = (over: Parameters<typeof createLiveSocket>[0] = {}) =>
  createLiveSocket({ createSocket: u => new FakeSocket(u), random: () => 0.5, url: () => 'ws://x/api/ws', ...over });

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('сокет: состояние и события', () => {
  it('connecting → open; события — в onEvent и подписчикам нужного типа; мусор игнорируется', () => {
    const onEvent = vi.fn();
    const onOpen = vi.fn();
    const sock = make({ onEvent, onOpen });
    const all = vi.fn();
    const only = vi.fn();
    sock.subscribe(all);
    sock.subscribe(only, 'track.status');
    expect(sock.state.getState().state).toBe('connecting');
    sock.start();
    expect(sock.state.getState().state).toBe('connecting');
    expect(last().url).toBe('ws://x/api/ws');
    last().open();
    expect(sock.state.getState().state).toBe('open');
    expect(onOpen).toHaveBeenCalledTimes(1);

    last().send({ track_id: 1, type: 'track.status' });
    last().send({ type: 'sync.poke' });
    last().send('не json');
    last().send({ нет: 'type' });
    last().send('42');
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(all).toHaveBeenCalledTimes(2);
    expect(only).toHaveBeenCalledTimes(1);
    expect(only).toHaveBeenCalledWith({ track_id: 1, type: 'track.status' });
  });

  it('отписка прекращает доставку; start повторно не создаёт второе соединение', () => {
    const sock = make();
    const h = vi.fn();
    const off = sock.subscribe(h);
    sock.start();
    sock.start();
    expect(FakeSocket.all).toHaveLength(1);
    last().open();
    off();
    last().send({ type: 'a' });
    expect(h).not.toHaveBeenCalled();
  });
});

describe('сокет: переподключение', () => {
  it('пауза растёт 1 → 2 → 4 с, не превышает максимум и сбрасывается после успешного соединения', () => {
    const sock = make();
    sock.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = FakeSocket.all.length;
      last().drop();
      expect(sock.state.getState().state).toBe('closed');
      // Ищем момент, когда создаётся новое соединение.
      let waited = 0;
      while (FakeSocket.all.length === before && waited < 100_000) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
    }
    expect(delays.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(delays[6]).toBe(SOCKET_MAX_DELAY_MS);

    last().open();
    const before = FakeSocket.all.length;
    last().drop();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(before + 1);
  });

  it('джиттер ±20 %', () => {
    const low = make({ random: () => 0 });
    low.start();
    last().drop();
    vi.advanceTimersByTime(799);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('ошибка сокета закрывает его и запускает переподключение; onOpen вызывается при каждом открытии', () => {
    const onOpen = vi.fn();
    const sock = make({ onOpen });
    sock.start();
    last().open();
    last().onerror?.({});
    expect(last().closed).toBe(true);
    last().drop();
    vi.advanceTimersByTime(1000);
    last().open();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('reconnect: немедленное новое соединение, старое закрыто, без накопления таймеров', () => {
    const sock = make();
    sock.start();
    last().open();
    const old = last();
    sock.reconnect();
    expect(old.closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
    last().drop();
    sock.reconnect();
    expect(FakeSocket.all).toHaveLength(3);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(3);
    make().reconnect(); // не запущен — ничего не делает
  });
});

describe('сокет: остановка', () => {
  it('stop закрывает соединение, отменяет переподключение и отключает обработчики', () => {
    const onEvent = vi.fn();
    const sock = make({ onEvent });
    sock.start();
    last().open();
    const s = last();
    sock.stop();
    expect(s.closed).toBe(true);
    expect(s.onmessage).toBeNull();
    expect(sock.state.getState().state).toBe('closed');
    s.onclose?.({});
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('stop во время подключения: закрытие откладывается до открытия', () => {
    const sock = make();
    sock.start();
    const s = last();
    sock.stop();
    expect(s.closed).toBe(false);
    s.readyState = 1;
    s.onopen?.({});
    expect(s.closed).toBe(true);
  });

  it('stop при отложенном переподключении отменяет таймер; после stop можно запустить снова', () => {
    const sock = make();
    sock.start();
    last().drop();
    sock.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    sock.start();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('по умолчанию строится адрес /api/ws и используется глобальный WebSocket', () => {
    const created: string[] = [];
    class G extends FakeSocket {
      constructor(url: string) {
        super(url);
        created.push(url);
      }
    }
    vi.stubGlobal('WebSocket', G);
    const sock = createLiveSocket();
    sock.start();
    expect(created[0]).toMatch(/^wss?:\/\/.+\/api\/ws$/);
    sock.stop();
  });
});
