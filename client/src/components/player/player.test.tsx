import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPlayer } from '@/lib/player';
import { toPlayerTrack } from '@/lib/player';
import { appData } from '@/lib/app-data';
import { installTestPlayer, seedPlayerLibrary } from '@/test/player-ui';
import { renderWithProviders } from '@/test/render';
import type * as TracksApi from '@/lib/api/tracks';
import { Player } from './player';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => true }));
vi.mock('@/lib/api/tracks', async importOriginal => ({
  ...(await importOriginal<typeof TracksApi>()),
  getAudioInfo: vi.fn(async (id: number) => ({
    bit_depth: 16,
    bitrate_kbps: null,
    channels: 'stereo',
    codec: id === 10 ? 'flac' : 'mp3',
    ext: 'flac',
    sample_rate: 44100,
    transcoded: false,
  })),
}));

const track = (id: number) => {
  const { library, selectors } = appData();
  return toPlayerTrack(selectors.trackView(library.getState(), id)!);
};
const album = () => [10, 11, 12, 13].map(track);

function mount() {
  const env = installTestPlayer();
  const view = renderWithProviders(<Player />);
  return { ...env, ...view };
}
const playFirst = (env: ReturnType<typeof mount>) => act(() => env.ctl.play(track(10), album()));

beforeEach(() => seedPlayerLibrary());
afterEach(() => resetPlayer(true));

describe('панель плеера', () => {
  it('без трека: подсказка, управление заблокировано, мини-плеера нет', () => {
    mount();
    expect(screen.getAllByText('Ничего не играет').length).toBeGreaterThan(0);
    expect(screen.getByText('Выберите трек, чтобы начать')).toBeInTheDocument();
    expect(screen.getByTestId('player-play-pause')).toBeDisabled();
    expect(screen.queryByTestId('mini-player')).not.toBeInTheDocument();
    expect(screen.getByTestId('player-seek')).toBeDisabled();
  });

  it('показывает текущий трек, состояние кнопок, ссылки на альбом и артиста', () => {
    const env = mount();
    playFirst(env);
    const bar = within(screen.getByTestId('player-bar'));
    expect(bar.getAllByText('Song One').length).toBeGreaterThan(0);
    const link = bar.getAllByRole('link', { name: 'Song One' })[0];
    expect(link).toHaveAttribute('href', '/album/2');
    expect(bar.getAllByRole('link', { name: 'Art' })[0]).toHaveAttribute('href', '/artist/1');
    const pp = bar.getByTestId('player-play-pause');
    expect(pp).toBeEnabled();
    expect(pp).toHaveAttribute('data-playing', 'true');
    act(() => env.engine.emit({ type: 'paused' }));
    expect(pp).not.toHaveAttribute('data-playing');
    expect(pp).toHaveAccessibleName('Играть');
  });

  it('кнопки: пуск/пауза, следующий, предыдущий; «следующий» заблокирован на последнем треке', async () => {
    const env = mount();
    playFirst(env);
    const bar = within(screen.getByTestId('player-bar'));
    await userEvent.click(bar.getByTestId('player-play-pause'));
    expect(env.engine.paused).toBe(true);
    await userEvent.click(bar.getByRole('button', { name: 'Следующий' }));
    expect(env.ctl.state.index).toBe(1); // «Not Yet» (adding) пропущен — но следующий за 10 это 11
    await userEvent.click(bar.getByRole('button', { name: 'Следующий' }));
    expect(env.ctl.state.queue[env.ctl.state.index].id).toBe(13);
    expect(bar.getByRole('button', { name: 'Следующий' })).toBeDisabled();
    env.engine.setPosition(0.5);
    await userEvent.click(bar.getByRole('button', { name: 'Предыдущий' }));
    expect(env.ctl.state.queue[env.ctl.state.index].id).toBe(11);
  });

  it('shuffle и repeat: aria-pressed и подписи', async () => {
    const env = mount();
    playFirst(env);
    const bar = within(screen.getByTestId('player-bar'));
    const shuffle = bar.getByTestId('player-shuffle');
    expect(shuffle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(shuffle);
    expect(shuffle).toHaveAttribute('aria-pressed', 'true');
    const repeat = bar.getByTestId('player-repeat');
    expect(repeat).toHaveAccessibleName('Повтор: выкл.');
    await userEvent.click(repeat);
    expect(repeat).toHaveAccessibleName('Повтор: очередь');
    expect(repeat).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(repeat);
    expect(repeat).toHaveAccessibleName('Повтор: трек');
  });

  it('полоса прогресса: время, буфер, перемотка', async () => {
    const env = mount();
    playFirst(env);
    env.engine.setPosition(3, 10, [[0, 4]]);
    act(() => env.ctl.seekTo(3)); // событие состояния → чтение позиции
    const bar = within(screen.getByTestId('player-bar'));
    await waitFor(() => expect(bar.getByTestId('player-elapsed')).toHaveTextContent('0:03'));
    const buffered = bar.getByTestId('player-buffered');
    expect(buffered).toHaveStyle({ left: '0%', width: '40%' });
    expect(bar.getByTestId('player-seek')).toHaveAttribute('max', '10');
    fireEvent.change(bar.getByTestId('player-seek'), { target: { value: '7' } });
    expect(env.engine.seeks.at(-1)).toBe(7);
  });

  it('громкость и «без звука»', async () => {
    const env = mount();
    const bar = within(screen.getByTestId('player-bar'));
    fireEvent.change(bar.getByRole('slider', { name: 'Громкость' }), { target: { value: '30' } });
    expect(env.engine.volume).toBe(0.3);
    await userEvent.click(bar.getByRole('button', { name: 'Выключить звук' }));
    expect(env.engine.volume).toBe(0);
    expect(bar.getByRole('button', { name: 'Включить звук' })).toBeInTheDocument();
    expect(bar.getByRole('slider', { name: 'Громкость' })).toHaveValue('0');
  });

  it('мини-плеер (мобильный): трек, управление, очередь', async () => {
    const env = mount();
    playFirst(env);
    const mini = within(screen.getByTestId('mini-player'));
    expect(mini.getAllByText('Song One').length).toBeGreaterThan(0);
    await userEvent.click(mini.getByRole('button', { name: 'Следующий' }));
    expect(env.ctl.state.index).toBe(1);
    await userEvent.click(mini.getByRole('button', { name: 'Очередь' }));
    expect(screen.getByTestId('queue-panel')).toHaveAttribute('aria-hidden', 'false');
    await userEvent.click(mini.getByRole('button', { name: 'Предыдущий' }));
  });

  it('меню трека: «Перейти к альбому/артисту», «Убрать из очереди»', async () => {
    const env = mount();
    playFirst(env);
    await userEvent.click(within(screen.getByTestId('player-bar')).getByTestId('player-track-menu'));
    expect(await screen.findByRole('menuitem', { name: 'Перейти к альбому' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Перейти к артисту' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Убрать из очереди' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Перейти к артисту' }));
    await waitFor(() => expect(env.ctl.state.index).toBe(0));
  });
});

describe('статус под полосой', () => {
  it('подключение к раздаче, прогресс загрузки из live-store, ошибка', async () => {
    const env = mount();
    playFirst(env);
    // Трек 11 в статусе found (не скачан на сервер)
    act(() => env.ctl.playIndex(1));
    const status = () => within(screen.getByTestId('player-bar')).queryByTestId('player-status');
    // Короткое подключение не моргает подписью: она появляется после задержки.
    expect(status()).toBeNull();
    await waitFor(() => expect(status()).toHaveTextContent('Подключаемся к раздаче'));
    act(() =>
      appData().live.getState().setStreamProgress(11, { bytes_done: 0, bytes_total: 100, down_speed_bps: 0, peers: 3 }),
    );
    expect(status()).toHaveTextContent('Подключаемся к раздаче… (пиров: 3)');
    act(() =>
      appData()
        .live.getState()
        .setStreamProgress(11, { bytes_done: 34, bytes_total: 100, down_speed_bps: 1258291, peers: 12 }),
    );
    expect(status()).toHaveTextContent('Загрузка из торрента: 34% · 12 пиров · 1.2 МБ/с');
    // чужой трек игнорируется
    act(() =>
      appData()
        .live.getState()
        .setStreamProgress(13, { bytes_done: 90, bytes_total: 100, down_speed_bps: 1, peers: 1 }),
    );
    expect(status()).toHaveTextContent('34%');
    // отмена
    await userEvent.click(within(screen.getByTestId('player-bar')).getByRole('button', { name: 'Отменить' }));
    expect(env.ctl.state.status).toBe('idle');
    expect(status()).toBeNull();
  });

  it('ready: подпись «Подключаемся к раздаче» не показывается даже при долгой загрузке', async () => {
    const env = mount();
    playFirst(env); // трек 10 — ready
    await new Promise(r => setTimeout(r, 1000));
    expect(within(screen.getByTestId('player-bar')).queryByText(/Подключаемся/)).toBeNull();
    expect(env.ctl.state.index).toBe(0);
  });

  it('ready: прогресса загрузки нет; ошибка показывает текст', () => {
    const env = mount();
    playFirst(env); // трек 10 — ready
    act(() =>
      appData().live.getState().setStreamProgress(10, { bytes_done: 5, bytes_total: 100, down_speed_bps: 1, peers: 1 }),
    );
    act(() => env.engine.emit({ type: 'playing' }));
    expect(within(screen.getByTestId('player-bar')).queryByTestId('player-status')).toBeNull();
    act(() => env.engine.emit({ code: 'media', type: 'error' }));
    return waitFor(() =>
      expect(within(screen.getByTestId('player-bar')).getByTestId('player-status')).toHaveTextContent('Нет пиров'),
    );
  });
});

describe('очередь', () => {
  const open = async () => {
    const env = mount();
    playFirst(env);
    await userEvent.click(within(screen.getByTestId('player-bar')).getByTestId('player-queue'));
    return { ...env, panel: screen.getByTestId('queue-panel') };
  };

  it('показывает текущий трек и «Далее»; недоступный трек заблокирован', async () => {
    const { panel } = await open();
    const rows = within(panel).getAllByTestId('queue-row');
    expect(rows.map(r => r.getAttribute('data-track-id'))).toEqual(['10', '11', '12', '13']);
    expect(rows[2].querySelector('button')).toBeDisabled();
  });

  it('переход по клику на трек', async () => {
    const { panel, ctl } = await open();
    await userEvent.click(within(panel).getAllByTestId('queue-row')[3].querySelector('button')!);
    expect(ctl.state.queue[ctl.state.index].id).toBe(13);
  });

  it('удаление и перестановка', async () => {
    const { panel, ctl } = await open();
    await userEvent.click(within(panel).getByRole('button', { name: 'Выше: Song Four' }));
    expect(ctl.state.queue.map(t => t.id)).toEqual([10, 11, 13, 12]);
    await userEvent.click(within(panel).getByRole('button', { name: 'Ниже: Song Two' }));
    expect(ctl.state.queue.map(t => t.id)).toEqual([10, 13, 11, 12]);
    // крайние позиции: «выше» у первого из следующих и «ниже» у последнего недоступны
    expect(within(panel).getByRole('button', { name: 'Выше: Song Four', hidden: true })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Ниже: Not Yet', hidden: true })).toBeDisabled();
    await userEvent.click(within(panel).getByRole('button', { name: 'Убрать из очереди: Not Yet' }));
    expect(ctl.state.queue.map(t => t.id)).toEqual([10, 13, 11]);
  });

  it('закрывается кнопкой и Esc; закрытая панель недоступна для фокуса', async () => {
    const { panel } = await open();
    expect(panel).toHaveAttribute('aria-hidden', 'false');
    await userEvent.click(within(panel).getByRole('button', { name: 'Закрыть очередь' }));
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(panel).toHaveAttribute('inert');
    await userEvent.click(within(screen.getByTestId('player-bar')).getByTestId('player-queue'));
    expect(panel).toHaveAttribute('aria-hidden', 'false');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel).toHaveAttribute('aria-hidden', 'true');
  });

  it('пустая очередь', () => {
    mount();
    expect(within(screen.getByTestId('queue-panel')).getByText('Очередь пуста')).toBeInTheDocument();
  });

  it('очередь без следующих треков', async () => {
    const env = mount();
    act(() => env.ctl.play(track(10), [track(10)]));
    await userEvent.click(within(screen.getByTestId('player-bar')).getByTestId('player-queue'));
    expect(screen.getByText('Больше треков в очереди нет')).toBeInTheDocument();
  });
});

describe('очередь: тень', () => {
  it('у закрытой панели нет тени (иначе она просачивается полосой у правого края экрана), у открытой — есть', async () => {
    const env = mount();
    playFirst(env);
    const panel = screen.getByTestId('queue-panel');
    expect(panel).not.toHaveClass('shadow-2xl');
    await userEvent.click(within(screen.getByTestId('player-bar')).getByTestId('player-queue'));
    expect(panel).toHaveClass('shadow-2xl');
  });
});

describe('планшетная панель (sm…lg)', () => {
  it('обложка с названием открывает полноэкранный плеер, рядом кнопка очереди — без неё планшет не мог ни того, ни другого', async () => {
    const env = mount();
    playFirst(env);
    const bar = within(screen.getByTestId('player-bar'));
    // Первая кнопка — обложка десктопной панели (lg), последняя — планшетной.
    await userEvent.click(bar.getAllByRole('button', { name: 'Развернуть плеер' }).at(-1) as HTMLElement);
    expect(screen.getByTestId('full-player')).toHaveAttribute('aria-hidden', 'false');
    const queue = bar.getAllByRole('button', { name: 'Очередь' });
    expect(queue.length).toBeGreaterThan(1);
    await userEvent.click(queue[0] as HTMLElement);
    expect(screen.getByTestId('queue-panel')).toHaveAttribute('aria-hidden', 'false');
  });
});

describe('полноэкранный режим', () => {
  const full = () => screen.getByTestId('full-player');
  const open = async () => {
    const env = mount();
    playFirst(env);
    await userEvent.click(screen.getByTestId('player-expand'));
    return env;
  };
  const swipe = (target: HTMLElement, [x0, y0]: [number, number], [x1, y1]: [number, number]) => {
    const t = (x: number, y: number) => ({ clientX: x, clientY: y });
    fireEvent.touchStart(target, { touches: [t(x0, y0)] });
    fireEvent.touchEnd(target, { changedTouches: [t(x1, y1)], touches: [] });
  };

  it('открывается и закрывается: ручка, шеврон, Esc', async () => {
    await open();
    expect(full()).toHaveAttribute('aria-hidden', 'false');
    expect(within(full()).getByTestId('full-player-title')).toHaveTextContent('Song One');
    await userEvent.click(within(full()).getByTestId('full-player-close'));
    expect(full()).toHaveAttribute('aria-hidden', 'true');
    expect(full()).toHaveAttribute('inert');
    await userEvent.click(screen.getByTestId('player-expand'));
    await userEvent.click(within(full()).getAllByRole('button', { name: 'Свернуть плеер' }).at(-1)!);
    expect(full()).toHaveAttribute('aria-hidden', 'true');
    await userEvent.click(screen.getByTestId('player-expand'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(full()).toHaveAttribute('aria-hidden', 'true');
  });

  it('открывается и с настольной панели (обложка)', async () => {
    const env = mount();
    playFirst(env);
    await userEvent.click(
      within(screen.getByTestId('player-bar')).getAllByRole('button', { name: 'Развернуть плеер' })[0],
    );
    expect(full()).toHaveAttribute('aria-hidden', 'false');
  });

  it('без трека полноэкранный плеер не открывается; закрытый — не диалог', async () => {
    const env = mount();
    expect(full()).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('dialog')).toBeNull();
    playFirst(env);
    await userEvent.click(screen.getByTestId('player-expand'));
    expect(screen.getByRole('dialog', { name: 'Развернуть плеер' })).toBeInTheDocument();
  });

  it('свайп по обложке: влево — следующий, вправо — предыдущий; направление анимации', async () => {
    const env = await open();
    const cover = within(full()).getByTestId('full-player-cover');
    const block = () => within(full()).getByTestId('full-player-title').closest('[class*="animate-track"]')!;
    expect(block()).toHaveClass('animate-track-next');
    swipe(cover, [250, 300], [100, 305]);
    expect(env.ctl.state.queue[env.ctl.state.index].id).toBe(11);
    expect(within(full()).getByTestId('full-player-title')).toHaveTextContent('Song Two');
    swipe(cover, [100, 300], [250, 295]);
    expect(env.ctl.state.queue[env.ctl.state.index].id).toBe(10);
    expect(block()).toHaveClass('animate-track-prev');
  });

  it('короткий или преимущественно вертикальный свайп трек не меняет', async () => {
    const env = await open();
    const cover = within(full()).getByTestId('full-player-cover');
    swipe(cover, [200, 300], [170, 300]);
    swipe(cover, [250, 200], [150, 400]);
    expect(env.ctl.state.index).toBe(0);
  });

  it('смахивание вниз закрывает плеер; короткое — нет', async () => {
    await open();
    const drag = (dy: number) => {
      fireEvent.touchStart(full(), { touches: [{ clientX: 100, clientY: 100 }] });
      fireEvent.touchMove(full(), { touches: [{ clientX: 100, clientY: 100 + dy }] });
      expect(full().style.transform).toBe(`translateY(${dy}px)`);
      fireEvent.touchEnd(full());
    };
    drag(40);
    expect(full()).toHaveAttribute('aria-hidden', 'false');
    expect(full().style.transform).toBe('translateY(0px)');
    drag(160);
    expect(full()).toHaveAttribute('aria-hidden', 'true');
  });

  it('жест на ползунке не закрывает плеер; движение вверх не тянет окно', async () => {
    await open();
    const slider = within(full()).getByRole('slider', { name: 'Перемотка' });
    fireEvent.touchStart(slider, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(slider, { touches: [{ clientX: 100, clientY: 400 }] });
    fireEvent.touchEnd(slider);
    expect(full()).toHaveAttribute('aria-hidden', 'false');
    fireEvent.touchStart(full(), { touches: [{ clientX: 100, clientY: 300 }] });
    fireEvent.touchMove(full(), { touches: [{ clientX: 100, clientY: 100 }] });
    expect(full().style.transform).toBe('translateY(0px)');
    fireEvent.touchCancel(full());
    fireEvent.touchEnd(full()); // без начала жеста — ничего
  });

  it('жест в меню «…» (портал) не тянет и не закрывает плеер', async () => {
    await open();
    await userEvent.click(within(full()).getByTestId('player-track-menu'));
    const item = await screen.findByRole('menuitem', { name: /плейлист/i });
    fireEvent.touchStart(item, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(item, { touches: [{ clientX: 100, clientY: 400 }] });
    expect(full().style.transform).toBe('translateY(0px)');
    fireEvent.touchEnd(item);
    expect(full()).toHaveAttribute('aria-hidden', 'false');
  });

  it('строка качества: показывает параметры, при смене трека старый текст гаснет', async () => {
    const env = await open();
    const span = () => within(full()).getByTestId('audio-quality').querySelector('span')!;
    await waitFor(() => expect(span()).toHaveTextContent('FLAC'));
    expect(span()).toHaveClass('opacity-100');
    act(() => env.ctl.next());
    await waitFor(() => expect(span()).toHaveTextContent('MP3'));
    expect(span()).toHaveClass('opacity-100');
  });

  it('кнопки полноэкранного плеера: пауза, shuffle, repeat, очередь, меню; ссылки сворачивают плеер', async () => {
    const env = await open();
    const f = within(full());
    await userEvent.click(f.getByTestId('full-player-play-pause'));
    expect(env.engine.paused).toBe(true);
    await userEvent.click(f.getByRole('button', { name: 'Перемешать' }));
    expect(env.ctl.state.shuffle).toBe(true);
    await userEvent.click(f.getByRole('button', { name: 'Повтор: выкл.' }));
    expect(env.ctl.state.repeat).toBe('all');
    await userEvent.click(f.getByRole('button', { name: 'Очередь' }));
    expect(screen.getByTestId('queue-panel')).toHaveAttribute('aria-hidden', 'false');
    await userEvent.click(f.getByRole('link', { name: 'Song One' }));
    expect(full()).toHaveAttribute('aria-hidden', 'true');
  });
});
