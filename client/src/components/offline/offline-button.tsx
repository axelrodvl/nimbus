import * as Ariakit from '@ariakit/react';
import { ArrowDownToLine, Check, Clock, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { menuItemClass } from '@/components/library/row-menu';
import type { MessageKey } from '@/lib/i18n/messages';
import { useT } from '@/lib/i18n/provider';
import type { OfflineItemState } from '@/lib/offline/status';
import { cn } from '@/lib/utils';
import { ProgressRing } from './ring';

export type OfflineButtonProps = {
  state: OfflineItemState;
  /** Название трека/альбома/плейлиста — в подписи для экранных читалок. */
  title: string;
  /** Размер: `sm` — строка трека, `md` — шапка (круглая кнопка). */
  size?: 'sm' | 'md';
  /** С видимой подписью («На устройство»): шапка альбома, где рядом кнопка «Скачать на сервер». */
  withLabel?: boolean;
  /** Часть треков скачана — доля 0…1 для кольца (альбом, плейлист). */
  fraction?: number;
  /** Закреплено ли (у «partial»: закреплённое можно повторить/удалить, незакреплённое — докачать). */
  pinned?: boolean;
  onPin: () => void;
  /** Отменить скачивание (из очереди и в процессе). */
  onCancel: () => void;
  onRemove: () => void;
  onRetry: () => void;
  'data-testid'?: string;
};

const ROUND = { md: 'size-10 pointer-coarse:size-11', sm: 'size-8 pointer-coarse:size-10' } as const;
const ICON = { md: 'size-5', sm: 'size-4' } as const;
const RING = { md: 32, sm: 24 } as const;

const base =
  'focus-visible:ring-accent/40 inline-flex shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:outline-none';
const idle =
  'border-divider dark:border-divider-dark text-gray hover:bg-card dark:hover:bg-card-dark hover:text-black dark:hover:text-white';
// Кнопка с подписью (шапка альбома) стоит рядом с «Слушать» и «На сервере»: те же размер и нейтральный вид.
const neutral =
  'border-divider dark:border-divider-dark text-black dark:text-white hover:bg-card dark:hover:bg-card-dark';
const active = 'border-accent text-accent-fg hover:bg-card dark:hover:bg-card-dark';

type MenuItem = { label: string; onClick: () => void; testId: string };
type View = {
  icon: ReactNode;
  /** Короткая видимая подпись (при `withLabel`). */
  text: string;
  aria: string;
  cls: string;
  onClick?: () => void;
  tip?: string;
  menu?: MenuItem[];
};

/**
 * Кнопка «на устройство»: `none` (стрелка вниз) → `queued` (часы) → `downloading` (кольцо, нажатие — отмена) →
 * `done` (галочка, нажатие — меню «Удалить с устройства») → `failed` (восклицательный знак, нажатие — повтор);
 * у альбома и плейлиста есть ещё `partial` (кольцо с долей).
 */
export function OfflineButton({
  state,
  title,
  size = 'md',
  withLabel = false,
  fraction = 0,
  pinned = false,
  onPin,
  onCancel,
  onRemove,
  onRetry,
  ...rest
}: OfflineButtonProps) {
  const t = useT();
  const icon = ICON[size];
  const ringSize = withLabel ? 20 : RING[size];
  const aria = (key: MessageKey, params?: Record<string, number>) => t(key, { title, ...params });
  const remove: MenuItem = { label: t('offline.remove'), onClick: onRemove, testId: 'offline-remove' };

  let view: View;
  switch (state.kind) {
    case 'done':
      view = {
        aria: aria('offline.state.done'),
        // В шапке (с подписью) «готово» выглядит как соседние кнопки; акцентом остаётся только галочка.
        cls: withLabel
          ? `${neutral} [&_svg]:text-accent-fg`
          : 'border-accent bg-accent/10 text-accent-fg hover:bg-accent/20',
        icon: <Check aria-hidden className={icon} strokeWidth={3} />,
        menu: [remove],
        text: t('offline.short.done'),
      };
      break;
    case 'partial': {
      const pct = Math.round(fraction * 100);
      view = {
        aria: aria('offline.state.partial', { percent: pct }),
        cls: idle,
        icon: (
          <ProgressRing progress={fraction} size={ringSize}>
            <ArrowDownToLine aria-hidden className="text-gray size-3" />
          </ProgressRing>
        ),
        // Закреплённое с недостающими треками — повтор и удаление; незакреплённое (треки скачаны по одному) — докачать.
        menu: pinned ? [{ label: t('offline.retry'), onClick: onRetry, testId: 'offline-retry' }, remove] : undefined,
        onClick: pinned ? undefined : onPin,
        text: t('offline.short.none'),
      };
      break;
    }
    case 'downloading': {
      const pct = Math.round(state.progress * 100);
      view = {
        aria: aria('offline.state.downloading', { percent: pct }),
        cls: active,
        icon: (
          <ProgressRing progress={state.progress} size={ringSize}>
            <span aria-hidden className="bg-accent size-2 rounded-sm" />
          </ProgressRing>
        ),
        onClick: onCancel,
        text: t('offline.short.downloading', { percent: pct }),
        tip: t('offline.cancel'),
      };
      break;
    }
    case 'queued':
      view = {
        aria: aria('offline.state.queued'),
        cls: idle,
        icon: <Clock aria-hidden className={icon} />,
        onClick: onCancel,
        text: t('offline.short.queued'),
        tip: t('offline.cancel'),
      };
      break;
    case 'failed':
      view = {
        aria: aria('offline.state.failed'),
        cls: 'border-danger text-danger-fg hover:bg-card dark:hover:bg-card-dark',
        icon: <TriangleAlert aria-hidden className={icon} />,
        onClick: onRetry,
        text: t('offline.short.failed'),
        tip: t('offline.retry'),
      };
      break;
    default:
      view = {
        aria: aria('offline.state.none'),
        cls: idle,
        icon: <ArrowDownToLine aria-hidden className={icon} />,
        onClick: onPin,
        text: t('offline.short.none'),
        tip: t('offline.download'),
      };
  }

  const cls = cn(
    base,
    withLabel ? 'h-9 gap-2 px-4 text-sm font-medium pointer-coarse:h-11' : ROUND[size],
    withLabel && view.cls === idle ? neutral : view.cls,
  );
  const content = (
    <>
      {view.icon}
      {withLabel ? <span>{view.text}</span> : null}
    </>
  );
  const common = {
    'aria-label': view.aria,
    className: cls,
    'data-state': state.kind,
    'data-testid': rest['data-testid'] ?? 'offline-button',
  };

  if (view.menu) {
    return (
      <Ariakit.MenuProvider>
        <Ariakit.MenuButton {...common}>{content}</Ariakit.MenuButton>
        <Ariakit.Menu
          className="border-divider dark:border-divider-dark z-[70] min-w-44 rounded-lg border bg-white p-1 text-black shadow-lg dark:bg-black dark:text-white"
          gutter={4}
          portal
        >
          {view.menu.map(item => (
            <Ariakit.MenuItem
              className={menuItemClass}
              data-testid={item.testId}
              key={item.testId}
              onClick={item.onClick}
            >
              {item.label}
            </Ariakit.MenuItem>
          ))}
        </Ariakit.Menu>
      </Ariakit.MenuProvider>
    );
  }
  return (
    <button {...common} onClick={view.onClick} title={view.tip} type="button">
      {content}
    </button>
  );
}
