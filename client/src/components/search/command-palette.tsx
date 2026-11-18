import * as Ariakit from '@ariakit/react';
import { Disc3, Mic2, Music2, Search as SearchIcon, Zap } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { registeredPaths } from '@/app-routes';
import { ArtistAvatar } from '@/components/library/artist-avatar';
import { Cover } from '@/components/library/cover';
import { Spinner } from '@/components/ui/spinner';
import { useT } from '@/lib/i18n/provider';
import { useOnline } from '@/lib/live/hooks';
import { visibleNavItems } from '@/lib/nav/items';
import { addToLibrary, useIsAdding } from '@/lib/search/add';
import { addToHistory } from '@/lib/search/history';
import { buildPaletteItems, type PaletteAction, type PaletteItem } from '@/lib/search/palette-items';
import { useRemoteSearch } from '@/lib/search/use-remote-search';
import { useMbidIndex, useSearchLocal } from '@/lib/store/hooks';
import { setTheme, type Theme } from '@/lib/theme/theme';
import { cn } from '@/lib/utils';
import { ShortcutHint } from '@/components/shortcut-hint';

type PaletteContextValue = { open: () => void };
const PaletteContext = createContext<PaletteContextValue>({ open: () => undefined });

/** Открыть палитру из любого места оболочки (кнопка боковой панели). Вне провайдера — ничего не делает. */
export function useCommandPalette(): PaletteContextValue {
  return useContext(PaletteContext);
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Поле ввода или другой редактируемый элемент: клавиша `/` там — обычный символ. */
export function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE) !== null;
}

/** Открыт ли какой-то диалог (палитра не должна вклиниваться поверх него клавишей `/`). */
const dialogOpen = () => document.querySelector('[role="dialog"]') !== null;

const THEMES: Theme[] = ['light', 'dark', 'system'];

/**
 * iOS/Android открывают экранную клавиатуру только при `focus()`, вызванном синхронно в обработчике жеста.
 * Поле палитры монтируется после открытия диалога (уже вне жеста), поэтому заранее фокусируем временное
 * поле — клавиатура остаётся открытой, пока `autoFocus` реального поля не заберёт фокус.
 */
function primeKeyboard() {
  const proxy = document.createElement('input');
  proxy.setAttribute('aria-hidden', 'true');
  proxy.tabIndex = -1;
  proxy.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0';
  document.body.append(proxy);
  proxy.focus({ preventScroll: true });
  setTimeout(() => proxy.remove(), 1000);
}

/** Глобальные горячие клавиши (⌘K / Ctrl+K всегда, `/` — вне полей ввода и диалогов) и сама палитра. */
export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const store = Ariakit.useDialogStore();
  const isOpen = Ariakit.useStoreState(store, 'open');
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const show = () => {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      store.show();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (store.getState().open) store.hide();
        else show();
      } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented) {
        if (isEditable(e.target) || store.getState().open || dialogOpen()) return;
        e.preventDefault();
        show();
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [store]);

  const value = useMemo<PaletteContextValue>(
    () => ({
      open: () => {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        primeKeyboard();
        store.show();
      },
    }),
    [store],
  );

  return (
    <PaletteContext value={value}>
      {children}
      <Ariakit.Dialog
        aria-label={t('palette.label')}
        backdrop={<div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />}
        className="border-divider dark:border-divider-dark fixed top-[12vh] left-1/2 z-50 flex max-h-[70vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl border bg-white shadow-2xl outline-none dark:bg-[#181818]"
        finalFocus={returnFocus}
        store={store}
        unmountOnHide
      >
        {isOpen ? <PaletteBody onClose={() => store.hide()} /> : null}
      </Ariakit.Dialog>
    </PaletteContext>
  );
}

const groupIcon = { actions: Zap, album: Disc3, artist: Mic2, local: SearchIcon, track: Music2 } as const;
const groupTitle = {
  actions: 'palette.actions',
  album: 'group.albums',
  artist: 'group.artists',
  local: 'search.local',
  track: 'group.tracks',
} as const;

function ItemIcon({ item }: { item: PaletteItem }) {
  if (item.avatar) return <ArtistAvatar className="size-9 text-xs" mbid={item.avatar.mbid} name={item.avatar.name} />;
  if (item.group === 'actions') return <Zap aria-hidden className="text-gray size-5" />;
  return <Cover alt={item.title} className="size-9" src={item.cover} />;
}

function AddState({ item }: { item: PaletteItem }) {
  const t = useT();
  const adding = useIsAdding(item.add?.mbid ?? '');
  if (!item.add) return null;
  return adding ? (
    <span className="text-accent-fg inline-flex items-center gap-1 text-xs font-medium">
      <Spinner className="size-3.5" />
      {t('add.adding')}
    </span>
  ) : (
    <span className="text-muted text-xs">{t('add.addShort')}</span>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const online = useOnline();
  const [query, setQuery] = useState('');
  const [rawActive, setActive] = useState(0);
  const listId = useId();
  const local = useSearchLocal(query, 5);
  const remote = useRemoteSearch(query, online);
  const index = useMbidIndex();
  const trimmed = query.trim();

  const actions = useMemo<PaletteAction[]>(
    () => [
      ...visibleNavItems(registeredPaths).map(item => ({
        id: `go-${item.to}`,
        label: item.label,
        run: () => void navigate(item.to),
      })),
      ...THEMES.map(theme => ({ id: `theme-${theme}`, label: `theme.${theme}` as const, run: () => setTheme(theme) })),
    ],
    [navigate],
  );
  const items = useMemo(
    () => buildPaletteItems({ actions, index, local, query, remote: remote.data, t }),
    [actions, index, local, query, remote.data, t],
  );
  const active = Math.min(rawActive, Math.max(items.length - 1, 0));

  function activate(item: PaletteItem | undefined) {
    if (!item) {
      if (trimmed) {
        void navigate(`/search?q=${encodeURIComponent(trimmed)}`);
        onClose();
      }
      return;
    }
    if (item.add) {
      void addToLibrary(item.add, t, trimmed);
      return;
    }
    if (item.run) item.run();
    else if (item.href) {
      if (trimmed && item.group !== 'actions') addToHistory(trimmed);
      void navigate(item.href);
    }
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(items[active]);
    }
  }

  const failed = remote.error && !remote.data;
  return (
    <>
      <div className="border-divider dark:border-divider-dark flex items-center gap-3 border-b px-4 py-3">
        <SearchIcon aria-hidden className="text-gray size-5 shrink-0" />
        <input
          aria-activedescendant={items[active] ? `${listId}-${items[active].id}` : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={items.length > 0}
          aria-label={t('palette.inputLabel')}
          autoComplete="off"
          className="w-full bg-transparent py-1 text-base outline-none"
          autoFocus
          maxLength={200}
          onChange={e => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={t('palette.placeholder')}
          role="combobox"
          value={query}
        />
        {remote.loading || remote.retrying ? <Spinner className="text-gray size-4 shrink-0" /> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="palette-scroll">
        <ul
          aria-label={t('palette.results')}
          className="flex flex-col"
          id={listId}
          role="listbox"
        >
          {items.map((item, i) => {
            const Icon = groupIcon[item.group];
            const first = i === 0 || items[i - 1]?.group !== item.group;
            return (
              <li key={item.id} role="presentation">
                {first ? (
                  <div className="text-muted flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs font-medium">
                    <Icon aria-hidden className="size-3.5" />
                    {t(groupTitle[item.group])}
                  </div>
                ) : null}
                <div
                  aria-selected={i === active}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2',
                    i === active && 'bg-card dark:bg-card-dark',
                  )}
                  id={`${listId}-${item.id}`}
                  onClick={() => activate(item)}
                  onMouseMove={() => setActive(i)}
                  role="option"
                >
                  <ItemIcon item={item} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    {item.subtitle ? <span className="text-muted truncate text-xs">{item.subtitle}</span> : null}
                  </div>
                  {item.meta ? <span className="text-muted font-mono text-xs">{item.meta}</span> : null}
                  <AddState item={item} />
                </div>
              </li>
            );
          })}
        </ul>
        {failed ? (
          <p className="text-muted px-3 py-4 text-center text-sm" role="alert">
            {t('palette.failed', { error: remote.error?.message ?? '' })}
          </p>
        ) : null}
        {trimmed && !failed && !remote.loading && items.length === 0 ? (
          <p className="text-muted px-3 py-6 text-center text-sm">{t('palette.empty')}</p>
        ) : null}
      </div>

      <div className="border-divider dark:border-divider-dark text-muted flex items-center justify-between gap-3 border-t px-4 py-2.5 text-xs">
        {trimmed ? (
          <button
            className="text-accent-fg text-sm font-medium whitespace-nowrap hover:underline"
            onClick={() => activate(undefined)}
            type="button"
          >
            {t('palette.showAll')}
          </button>
        ) : (
          <span>{t('palette.startTyping')}</span>
        )}
        <span className="hidden items-center gap-3 whitespace-nowrap sm:flex">
          <span>
            <kbd className="font-mono">↑↓</kbd> {t('palette.hint.select')}
          </span>
          <span>
            <kbd className="font-mono">Enter</kbd> {t('palette.hint.open')}
          </span>
          <span>
            <kbd className="font-mono">Esc</kbd> {t('palette.hint.close')}
          </span>
          <ShortcutHint className="font-mono" />
        </span>
      </div>
    </>
  );
}
