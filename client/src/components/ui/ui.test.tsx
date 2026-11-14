import { useDialogStore } from '@ariakit/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { Button } from './button';
import { Collapsible } from './collapsible';
import { ConfirmDialog } from './confirm-dialog';
import { EmptyState } from './empty-state';
import { Equalizer } from './equalizer';
import { ErrorBoundary } from './error-boundary';
import { ErrorState } from './error-state';
import { Marquee } from './marquee';
import { MusicNote } from './music-note';
import { Skeleton } from './skeleton';
import { Spinner } from './spinner';
import { ThemeToggle } from './theme-toggle';

describe('Button', () => {
  it('имеет доступное имя и вызывает onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Играть</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Играть' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('варианты и размеры меняют классы; className дописывается', () => {
    render(
      <Button variant="secondary" size="sm" className="extra">
        B
      </Button>,
    );
    const b = screen.getByRole('button');
    expect(b).toHaveClass('border', 'px-3', 'extra');
    expect(b).toHaveAttribute('type', 'button');
  });

  it('pending блокирует кнопку и показывает спиннер', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button pending onClick={onClick}>
        Сохранить
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Сохранить' });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('svg')).not.toBeNull();
    await userEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('disabled блокирует без спиннера', () => {
    const { container } = render(<Button disabled>X</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('Skeleton / Spinner / Equalizer / MusicNote', () => {
  it('Skeleton скрыт от скринридеров и анимирован', () => {
    const { container } = render(<Skeleton className="h-4 w-10" />);
    const el = container.firstElementChild;
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveClass('skeleton-animation', 'h-4');
  });

  it('Spinner принимает className', () => {
    const { container } = render(<Spinner className="size-8" />);
    expect(container.querySelector('svg')).toHaveClass('animate-spin', 'size-8');
  });

  it('Equalizer рисует три полосы; размер меняет интервал', () => {
    const { container, rerender } = render(<Equalizer />);
    expect(container.querySelectorAll('span > span')).toHaveLength(3);
    expect(container.firstElementChild).toHaveClass('gap-0.5');
    rerender(<Equalizer size="lg" color="bg-danger" />);
    expect(container.firstElementChild).toHaveClass('gap-1');
    rerender(<Equalizer size="md" />);
    expect(container.firstElementChild).toHaveClass('gap-[3px]');
  });

  it('MusicNote задаёт размер', () => {
    const { container } = render(<MusicNote size={40} className="x" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '40');
    expect(svg).toHaveClass('x');
  });
});

describe('EmptyState', () => {
  it('показывает заголовок, пояснение и действие', () => {
    render(
      <EmptyState title="Пусто" body="Добавьте альбом">
        <button>Добавить</button>
      </EmptyState>,
    );
    expect(screen.getByText('Пусто')).toBeInTheDocument();
    expect(screen.getByText('Добавьте альбом')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Добавить' })).toBeInTheDocument();
  });

  it('без пояснения его нет в разметке', () => {
    render(<EmptyState title="Пусто" />);
    expect(screen.queryByText('Добавьте альбом')).toBeNull();
  });
});

describe('ErrorState', () => {
  it('заголовок по умолчанию из словаря; role=alert', () => {
    renderWithProviders(<ErrorState />);
    expect(screen.getByRole('alert')).toHaveTextContent('Что-то пошло не так');
  });

  it('заголовок, пояснение и действие; компактный вариант', () => {
    renderWithProviders(
      <ErrorState compact title="Нет сети" body="Проверьте подключение">
        <button>Повторить</button>
      </ErrorState>,
    );
    expect(screen.getByText('Нет сети')).toBeInTheDocument();
    expect(screen.getByText('Проверьте подключение')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('полный вариант без пояснения', () => {
    renderWithProviders(<ErrorState title="Сбой" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Сбой');
  });
});

describe('ErrorBoundary', () => {
  function Bomb({ explode }: { explode: boolean }) {
    if (explode) throw new Error('boom');
    return <p>всё хорошо</p>;
  }

  it('ловит ошибку рендера и по кнопке повторяет попытку', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let explode = true;
    function Wrapper() {
      const [, force] = useState(0);
      const fix = () => {
        explode = false;
        force(1);
      };
      return (
        <>
          <button onClick={fix}>починить</button>
          <ErrorBoundary title="Сломалось" compact>
            <Bomb explode={explode} />
          </ErrorBoundary>
        </>
      );
    }
    renderWithProviders(<Wrapper />);
    expect(screen.getByRole('alert')).toHaveTextContent('Сломалось');
    await userEvent.click(screen.getByRole('button', { name: 'починить' }));
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(screen.getByText('всё хорошо')).toBeInTheDocument();
  });

  it('без ошибки отдаёт детей как есть', () => {
    renderWithProviders(
      <ErrorBoundary>
        <p>ок</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('ок')).toBeInTheDocument();
  });
});

describe('Marquee', () => {
  it('короткий текст — без прокрутки', () => {
    render(<Marquee data-testid="m">Короткий</Marquee>);
    const box = screen.getByTestId('m');
    expect(box).toHaveClass('text-ellipsis');
    expect(box.querySelector('.marquee-run')).toBeNull();
  });

  it('длинный текст — включается анимация с рассчитанной дистанцией', async () => {
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, value: 300 });
    try {
      render(<Marquee data-testid="m">Очень длинное название трека</Marquee>);
      await waitFor(() => expect(screen.getByTestId('m').querySelector('.marquee-run')).not.toBeNull());
      const inner = screen.getByTestId('m').querySelector<HTMLElement>('.marquee-run');
      expect(inner?.style.getPropertyValue('--marquee-dist')).toBe('-300px');
    } finally {
      if (orig) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', orig);
    }
  });
});

describe('Collapsible', () => {
  it('содержит обе подписи и детей', () => {
    render(
      <Collapsible showMoreLabel="Ещё" showLessLabel="Свернуть">
        <p>скрытое</p>
      </Collapsible>,
    );
    expect(screen.getByText('Ещё')).toBeInTheDocument();
    expect(screen.getByText('Свернуть')).toBeInTheDocument();
    expect(screen.getByText('скрытое')).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  function Host({ action }: { action: () => Promise<boolean> }) {
    const store = useDialogStore();
    return (
      <>
        <button onClick={() => store.show()}>открыть</button>
        <ConfirmDialog store={store} title="Удалить?" description="Это необратимо" confirmAction={action} />
      </>
    );
  }

  it('показывает заголовок и описание, подтверждение закрывает диалог', async () => {
    const action = vi.fn(async () => true);
    renderWithProviders(<Host action={action} />);
    await userEvent.click(screen.getByRole('button', { name: 'открыть' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить?' });
    expect(dialog).toHaveTextContent('Это необратимо');
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(action).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('отказ действия оставляет диалог открытым; «Отмена» закрывает', async () => {
    const action = vi.fn(async () => false);
    renderWithProviders(<Host action={action} />);
    await userEvent.click(screen.getByRole('button', { name: 'открыть' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('пока действие выполняется, кнопки заблокированы', async () => {
    let finish: (ok: boolean) => void = () => {};
    const action = () => new Promise<boolean>(r => (finish = r));
    renderWithProviders(<Host action={action} />);
    await userEvent.click(screen.getByRole('button', { name: 'открыть' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Подтвердить' })).toBeDisabled();
    await act(async () => finish(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('ThemeToggle', () => {
  it('три кнопки с доступными именами; нажатие переключает тему и aria-pressed', async () => {
    renderWithProviders(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button', { name: 'Светлая тема' }));
    expect(screen.getByRole('button', { name: 'Светлая тема' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Тёмная тема' })).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement).not.toHaveClass('dark');
    await userEvent.click(screen.getByRole('button', { name: 'Тёмная тема' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(screen.getByRole('button', { name: /Системная|система/i })).toBeInTheDocument();
  });

  it('вариант inline без рамки', () => {
    const { container } = renderWithProviders(<ThemeToggle variant="inline" />);
    expect(container.querySelector('.border')).toBeNull();
  });
});
