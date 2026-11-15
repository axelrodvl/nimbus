import * as Ariakit from '@ariakit/react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { normalizeNumber, NumberInput } from '@/components/ui/number-input';
import { PasswordInput } from '@/components/ui/password-input';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-section';
import { Sheet } from '@/components/ui/sheet';
import { Slider } from '@/components/ui/slider';
import { moveItem, SortableList } from '@/components/ui/sortable-list';
import { Switch } from '@/components/ui/switch';
import { revealHorizontally, Tabs } from '@/components/ui/tabs';
import { TextInput } from '@/components/ui/text-input';
import { Tooltip } from '@/components/ui/tooltip';
import { renderWithProviders } from '@/test/render';

afterEach(() => vi.useRealTimers());

describe('Field / SettingsRow', () => {
  it('связывает подпись, описание и ошибку с элементом', () => {
    renderWithProviders(
      <Field description="Подсказка" error="Ошибка значения" label="Имя">
        <TextInput onChange={() => undefined} value="" />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Имя' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const described = input.getAttribute('aria-describedby') ?? '';
    expect(described.split(' ')).toHaveLength(2);
    expect(document.getElementById(described.split(' ')[1] ?? '')).toHaveTextContent('Ошибка значения');
  });

  it('поле без ошибки не помечено невалидным', () => {
    renderWithProviders(
      <Field label="Имя">
        <TextInput onChange={() => undefined} value="" />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Имя' });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('SettingsRow: имя, описание и ошибка привязаны к элементу; секция показывает заголовок', () => {
    render(
      <SettingsSection description="О разделе" title="Раздел">
        <SettingsRow description="Пояснение" error="Плохо" label="Переключатель">
          <Switch checked={false} onCheckedChange={() => undefined} />
        </SettingsRow>
        <SettingsRow group label="Группа">
          <span>x</span>
        </SettingsRow>
      </SettingsSection>,
    );
    expect(screen.getByRole('heading', { name: 'Раздел' })).toBeInTheDocument();
    const sw = screen.getByRole('switch', { name: 'Переключатель' });
    expect(sw).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Плохо');
    expect(screen.getByRole('group', { name: 'Группа' })).toBeInTheDocument();
  });
});

describe('TextInput', () => {
  it('disabled и aria-label', () => {
    render(<TextInput aria-label="Запрос" disabled onChange={() => undefined} value="a" />);
    expect(screen.getByRole('textbox', { name: 'Запрос' })).toBeDisabled();
  });
});

describe('PasswordInput', () => {
  function Host({ secretSet }: { secretSet: boolean }) {
    const [v, setV] = useState('');
    return <PasswordInput aria-label="Пароль" onValueChange={setV} secretSet={secretSet} value={v} />;
  }

  it('секрет задан: пустое поле показывает маску в плейсхолдере, а значение остаётся пустым', () => {
    renderWithProviders(<Host secretSet />);
    const input = screen.getByLabelText('Пароль');
    expect(input).toHaveAttribute('placeholder', '••••');
    expect(input).toHaveValue('');
  });

  it('секрет не задан: плейсхолдера-маски нет; ввод попадает в значение', async () => {
    renderWithProviders(<Host secretSet={false} />);
    const input = screen.getByLabelText('Пароль');
    expect(input).not.toHaveAttribute('placeholder');
    await userEvent.type(input, 'abc');
    expect(input).toHaveValue('abc');
  });

  it('кнопка «показать» переключает тип поля', async () => {
    renderWithProviders(<Host secretSet={false} />);
    const input = screen.getByLabelText('Пароль');
    expect(input).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Показать' }));
    expect(input).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByRole('button', { name: 'Скрыть' }));
    expect(input).toHaveAttribute('type', 'password');
  });
});

describe('NumberInput', () => {
  it('normalizeNumber: границы, шаг, запятая, нечисловой ввод', () => {
    expect(normalizeNumber('5', { max: 10, min: 1 })).toBe(5);
    expect(normalizeNumber('50', { max: 10, min: 1 })).toBe(10);
    expect(normalizeNumber('-3', { max: 10, min: 1 })).toBe(1);
    expect(normalizeNumber('0,26', { step: 0.1 })).toBe(0.3);
    expect(normalizeNumber('7', { step: 5 })).toBe(5);
    expect(normalizeNumber('abc', {})).toBeNull();
    expect(normalizeNumber('  ', {})).toBeNull();
  });

  it('значение уходит по blur и Enter, только если изменилось; число ограничивается границами', async () => {
    const onCommit = vi.fn();
    render(<NumberInput aria-label="Лимит" max={30} min={1} onCommit={onCommit} unit="ГБ" value={8} />);
    const input = screen.getByLabelText('Лимит');
    expect(screen.getByText('ГБ')).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, '99');
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(30);
    onCommit.mockClear();
    await userEvent.clear(input);
    await userEvent.type(input, '12{Enter}');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(12);
  });

  it('нечисловой и неизменённый ввод ничего не отправляет и возвращает прежнее значение', async () => {
    const onCommit = vi.fn();
    render(<NumberInput aria-label="Лимит" max={30} min={1} onCommit={onCommit} value={8} />);
    const input = screen.getByLabelText('Лимит');
    input.focus();
    fireEvent.change(input, { target: { value: 'abc' } });
    await userEvent.tab();
    expect(input).toHaveValue(8);
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'a' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('колёсико снимает фокус и значение не меняет; disabled', () => {
    const onCommit = vi.fn();
    render(<NumberInput aria-label="Лимит" onCommit={onCommit} value={8} />);
    const input = screen.getByLabelText('Лимит');
    input.focus();
    fireEvent.wheel(input, { deltaY: 100 });
    expect(input).not.toHaveFocus();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('Switch / Checkbox', () => {
  it('Switch: role=switch, пробел и Enter переключают, disabled не реагирует', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch aria-label="Вкл" checked={false} onCheckedChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Вкл' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.tab();
    expect(sw).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(true);
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledTimes(2);
    rerender(<Switch aria-label="Вкл" checked disabled onCheckedChange={onChange} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('Checkbox: подпись — доступное имя; пробел переключает; disabled', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Checkbox checked={false} label="Live" onCheckedChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Live' });
    await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    rerender(<Checkbox checked disabled label="Live" onCheckedChange={onChange} />);
    expect(box).toBeDisabled();
    expect(box).toBeChecked();
  });
});

describe('Select', () => {
  const options = [
    { label: 'Альфа', value: 'a' },
    { label: 'Бета', value: 'b' },
    { label: 'Гамма', value: 'c' },
  ];

  function Host({ disabled }: { disabled?: boolean }) {
    const [v, setV] = useState('a');
    return (
      <Field label="Выбор">
        <Select disabled={disabled} onValueChange={setV} options={options} value={v} />
      </Field>
    );
  }

  it('имя берётся из поля; показывает выбранное; выбор мышью и клавиатурой', async () => {
    renderWithProviders(<Host />);
    const trigger = screen.getByRole('combobox', { name: 'Выбор' });
    expect(trigger).toHaveTextContent('Альфа');
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: 'Бета' }));
    expect(trigger).toHaveTextContent('Бета');
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    const list = await screen.findByRole('listbox');
    await userEvent.click(within(list).getByRole('option', { name: 'Гамма' }));
    expect(trigger).toHaveTextContent('Гамма');
  });

  it('значение вне списка показывается как есть; disabled не открывается', async () => {
    renderWithProviders(<Select aria-label="X" onValueChange={() => undefined} options={options} value="zzz" />);
    expect(screen.getByRole('combobox', { name: 'X' })).toHaveTextContent('zzz');
    renderWithProviders(<Host disabled />);
    expect(screen.getAllByRole('combobox')[1]).toBeDisabled();
  });
});

describe('SegmentedControl', () => {
  const options = [
    { label: 'Светлая', value: 'light' },
    { label: 'Тёмная', value: 'dark' },
    { label: 'Система', value: 'system' },
  ] as const;

  function Host({ disabled }: { disabled?: boolean }) {
    const [v, setV] = useState<'light' | 'dark' | 'system'>('light');
    return <SegmentedControl aria-label="Тема" disabled={disabled} onValueChange={setV} options={options} value={v} />;
  }

  it('radiogroup: выбран один; стрелки переносят выбор и фокус по кругу', async () => {
    render(<Host />);
    expect(screen.getByRole('radiogroup', { name: 'Тема' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Светлая' })).toBeChecked();
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Тёмная' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Тёмная' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Система' })).toBeChecked();
    await userEvent.keyboard('{a}');
    expect(screen.getByRole('radio', { name: 'Система' })).toBeChecked();
  });

  it('клик выбирает; disabled блокирует', async () => {
    const { unmount } = render(<Host />);
    await userEvent.click(screen.getByRole('radio', { name: 'Система' }));
    expect(screen.getByRole('radio', { name: 'Система' })).toBeChecked();
    unmount();
    render(<Host disabled />);
    expect(screen.getByRole('radio', { name: 'Тёмная' })).toBeDisabled();
  });
});

describe('Slider', () => {
  it('значение показывается сразу, наружу — одно итоговое через 600 мс', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<Slider aria-label="Порог" max={1} min={0} onCommit={onCommit} step={0.01} value={0.8} />);
    const input = screen.getByLabelText('Порог');
    fireEvent.change(input, { target: { value: '0.5' } });
    expect(document.querySelector('output')).toHaveTextContent('0.50');
    act(() => vi.advanceTimersByTime(300));
    fireEvent.change(input, { target: { value: '0.55' } });
    act(() => vi.advanceTimersByTime(599));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.55);
  });

  it('потеря фокуса отправляет значение сразу; без изменений ничего не уходит; размонтирование гасит таймер', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    const { unmount } = render(
      <Slider
        aria-label="Порог"
        format={v => `${Math.round(v * 100)}%`}
        max={1}
        min={0}
        onCommit={onCommit}
        step={0.01}
        value={0.8}
      />,
    );
    const input = screen.getByLabelText('Порог');
    expect(document.querySelector('output')).toHaveTextContent('80%');
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '0.3' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.3);
    fireEvent.change(input, { target: { value: '0.4' } });
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('disabled', () => {
    render(<Slider aria-label="Порог" disabled max={1} min={0} onCommit={() => undefined} value={0.5} />);
    expect(screen.getByLabelText('Порог')).toBeDisabled();
  });
});

describe('SortableList', () => {
  const items = [
    { id: 'a', label: 'FLAC' },
    { id: 'b', label: 'ALAC' },
    { id: 'c', label: 'MP3' },
  ];

  it('moveItem переносит элемент и игнорирует недопустимые позиции', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], -1, 1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 0, 5)).toEqual([1, 2, 3]);
  });

  it('кнопки вверх/вниз меняют порядок; крайние кнопки отключены', async () => {
    const onReorder = vi.fn();
    renderWithProviders(<SortableList aria-label="Форматы" items={items} onReorder={onReorder} />);
    expect(screen.getByRole('button', { name: 'Вверх: FLAC' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Вниз: MP3' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Вниз: FLAC' }));
    expect(onReorder).toHaveBeenLastCalledWith(['b', 'a', 'c']);
    await userEvent.click(screen.getByRole('button', { name: 'Вверх: MP3' }));
    expect(onReorder).toHaveBeenLastCalledWith(['a', 'c', 'b']);
  });

  it('перетаскивание за ручку: порядок меняется по положению указателя; тап без движения ничего не делает', () => {
    const onReorder = vi.fn();
    renderWithProviders(<SortableList aria-label="Форматы" items={items} onReorder={onReorder} />);
    const rows = screen.getAllByRole('listitem');
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () => ({
        bottom: i * 40 + 40,
        height: 40,
        left: 0,
        right: 100,
        top: i * 40,
        width: 100,
        x: 0,
        y: i * 40,
        toJSON: () => ({}),
      });
    });
    const handle = screen.getByTestId('handle-a');
    fireEvent.pointerDown(handle, { clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'a']);
    onReorder.mockClear();
    fireEvent.pointerDown(handle, { clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerDown(handle, { clientY: 10, pointerId: 1 });
    fireEvent.pointerCancel(handle);
    fireEvent.pointerMove(handle, { clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('disabled отключает кнопки и перетаскивание', () => {
    const onReorder = vi.fn();
    renderWithProviders(<SortableList aria-label="Форматы" disabled items={items} onReorder={onReorder} />);
    expect(screen.getByRole('button', { name: 'Вниз: FLAC' })).toBeDisabled();
    fireEvent.pointerDown(screen.getByTestId('handle-a'), { clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(screen.getByTestId('handle-a'), { pointerId: 1 });
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('ProgressBar / Badge / Tooltip', () => {
  it('ProgressBar: значения, ограничение сверху и нулевой максимум', () => {
    const { rerender } = render(<ProgressBar aria-label="Место" max={200} value={50} />);
    const bar = screen.getByRole('progressbar', { name: 'Место' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(bar.firstElementChild).toHaveStyle({ width: '25%' });
    rerender(<ProgressBar aria-label="Место" max={100} tone="danger" value={500} />);
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(bar.firstElementChild).toHaveStyle({ width: '100%' });
    rerender(<ProgressBar aria-label="Место" max={0} value={5} />);
    expect(bar.firstElementChild).toHaveStyle({ width: '0%' });
  });

  it('Badge показывает текст', () => {
    render(<Badge tone="success">Готово</Badge>);
    expect(screen.getByText('Готово')).toBeInTheDocument();
  });

  it('Tooltip показывается при фокусе элемента', async () => {
    render(
      <Tooltip text="Подсказка">
        <button type="button">Кнопка</button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Подсказка');
  });
});

describe('Tabs', () => {
  it('tablist: выбранная вкладка помечена; стрелки двигают фокус; выбор — onSelect', async () => {
    const onSelect = vi.fn();
    function Host() {
      const [id, setId] = useState('a');
      return (
        <Tabs
          aria-label="Вкладки"
          items={[
            { id: 'a', label: 'Первая' },
            { id: 'b', label: 'Вторая' },
          ]}
          onSelect={x => {
            onSelect(x);
            setId(x);
          }}
          selectedId={id}
        />
      );
    }
    render(<Host />);
    expect(screen.getByRole('tablist', { name: 'Вкладки' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Первая' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Вторая' })).toHaveFocus();
    await userEvent.click(screen.getByRole('tab', { name: 'Вторая' }));
    expect(onSelect).toHaveBeenLastCalledWith('b');
    expect(screen.getByRole('tab', { name: 'Вторая' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Tabs: прокрутка к выбранной вкладке', () => {
  const rect = (left: number, right: number) => () => ({ left, right }) as DOMRect;

  it('выбранная вкладка, не помещающаяся в прокручиваемую строку, сдвигает её по горизонтали (страница не трогается)', () => {
    const items = [
      { id: 'a', label: 'Первая' },
      { id: 'b', label: 'Вторая' },
    ];
    const pageScroll = vi.fn();
    Element.prototype.scrollIntoView = pageScroll;
    const { container, rerender } = render(
      <div style={{ overflowX: 'auto' }}>
        <Tabs aria-label="Вкладки" items={items} selectedId="a" />
      </div>,
    );
    const scroller = container.firstElementChild as HTMLElement;
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 500 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    scroller.getBoundingClientRect = rect(0, 200);
    screen.getByRole('tab', { name: 'Вторая' }).getBoundingClientRect = rect(260, 340);
    rerender(
      <div style={{ overflowX: 'auto' }}>
        <Tabs aria-label="Вкладки" items={items} selectedId="b" />
      </div>,
    );
    expect(scroller.scrollLeft).toBe(140);
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it('вкладка, выступающая слева, возвращается в поле зрения; без прокручиваемого предка ничего не происходит', () => {
    const el = document.createElement('button');
    const scroller = document.createElement('div');
    scroller.style.overflowX = 'scroll';
    scroller.append(el);
    document.body.append(scroller);
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 500 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    scroller.scrollLeft = 100;
    scroller.getBoundingClientRect = rect(0, 200);
    el.getBoundingClientRect = rect(-30, 50);
    revealHorizontally(el);
    expect(scroller.scrollLeft).toBe(70);
    scroller.remove();
    expect(() => revealHorizontally(document.createElement('button'))).not.toThrow();
  });
});

describe('Dialog / Sheet / ConfirmDialog', () => {
  function Host({ kind }: { kind: 'dialog' | 'sheet' }) {
    const store = Ariakit.useDialogStore();
    const Cmp = kind === 'sheet' ? Sheet : Dialog;
    return (
      <>
        <button onClick={store.show} type="button">
          Открыть
        </button>
        <Cmp description="Описание" store={store} title="Заголовок">
          <input aria-label="Поле" />
        </Cmp>
      </>
    );
  }

  it.each(['dialog', 'sheet'] as const)(
    '%s: открывается с именем и описанием, закрывается Escape, содержимое сбрасывается',
    async kind => {
      render(<Host kind={kind} />);
      await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
      const dlg = await screen.findByRole('dialog', { name: 'Заголовок' });
      expect(dlg).toHaveAccessibleDescription('Описание');
      await userEvent.type(screen.getByLabelText('Поле'), 'x');
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
      expect(await screen.findByLabelText('Поле')).toHaveValue('');
    },
  );

  it('ConfirmDialog: подтверждение закрывает окно, отказ действия оставляет его, пока идёт действие — закрыть нельзя', async () => {
    let resolve: (v: boolean) => void = () => undefined;
    const action = vi.fn(() => new Promise<boolean>(r => (resolve = r)));
    function Confirm() {
      const store = Ariakit.useDialogStore();
      return (
        <>
          <button onClick={store.show} type="button">
            Открыть
          </button>
          <ConfirmDialog confirmAction={action} description="Точно?" store={store} title="Удалить" variant="primary" />
        </>
      );
    }
    renderWithProviders(<Confirm />);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Удалить' })).toBeInTheDocument();
    await act(async () => resolve(false));
    expect(screen.getByRole('dialog', { name: 'Удалить' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await act(async () => resolve(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
