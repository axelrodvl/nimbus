'use client';

import * as Ariakit from '@ariakit/react';
import { Disc3, Mic2, Music2, Search as SearchIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useId, useState } from 'react';
import type { AddToLibraryInput } from '@/app/actions/library';
import { Cover } from '@/components/ui/cover';
import { Spinner } from '@/components/ui/spinner';
import { addToLibraryWithToast } from '@/features/search/add-to-library';
import { AddToLibraryButton, InLibraryBadge } from '@/features/search/components/add-to-library-button';
import { ArtistAvatar } from '@/features/search/components/artist-avatar';
import { albumHref, albumSubtitle, artistHref } from '@/features/search/components/search-results';
import { searchHref } from '@/features/search/components/search-view';
import { useSearch } from '@/hooks/use-search';
import { cn, formatDuration } from '@/lib/utils';
import type { Route } from 'next';

const MAX_ARTISTS = 3;
const MAX_ALBUMS = 3;
const MAX_TRACKS = 5;

type Item = {
  id: string;
  kind: 'artist' | 'album' | 'track';
  title: string;
  subtitle: string;
  libraryHref: Route | null;
  add: AddToLibraryInput;
  icon: React.ReactNode;
  meta?: string;
};

type PaletteContextValue = { open: () => void };
const PaletteContext = createContext<PaletteContextValue | null>(null);

export function useCommandPalette() {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('useCommandPalette must be used within CommandPaletteProvider');
  return ctx;
}

// Глобальный слушатель ⌘K / Ctrl+K и сама палитра.
export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const store = Ariakit.useDialogStore();
  const isOpen = Ariakit.useStoreState(store, 'open');

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        store.toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);

  return (
    <PaletteContext value={{ open: () => store.show() }}>
      {children}
      <Ariakit.Dialog
        store={store}
        unmountOnHide
        aria-label="Поиск"
        backdrop={<div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />}
        className="border-divider dark:border-divider-dark fixed top-[12vh] left-1/2 z-50 flex max-h-[70vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl border bg-white shadow-2xl outline-none dark:bg-[#181818]"
      >
        {isOpen ? <PaletteBody onClose={() => store.hide()} /> : null}
      </Ariakit.Dialog>
    </PaletteContext>
  );
}

function buildItems(data: ReturnType<typeof useSearch>['data']): Item[] {
  if (!data) return [];
  return [
    ...data.artists.slice(0, MAX_ARTISTS).map<Item>(a => ({
      add: { mbid: a.mbid, type: 'artist' },
      icon: <ArtistAvatar mbid={a.mbid} name={a.name} className="h-9 w-9 text-xs" />,
      id: `artist-${a.mbid}`,
      kind: 'artist',
      libraryHref: a.library_id != null ? artistHref(a.library_id) : null,
      subtitle: ['Артист', a.disambiguation, a.country].filter(Boolean).join(' · '),
      title: a.name,
    })),
    ...data.albums.slice(0, MAX_ALBUMS).map<Item>(a => ({
      add: { mbid: a.mbid, type: 'album' },
      icon: (
        <Cover
          src={a.cover_url}
          alt={a.title}
          size="sm"
          className="!h-9 !w-9"
          fallback={<Disc3 className="h-1/2 w-1/2 text-white/70" aria-hidden />}
        />
      ),
      id: `album-${a.mbid}`,
      kind: 'album',
      libraryHref: a.library_id != null ? albumHref(a.library_id) : null,
      subtitle: `Альбом · ${albumSubtitle(a)}`,
      title: a.title,
    })),
    ...data.tracks.slice(0, MAX_TRACKS).map<Item>(t => ({
      add: { album_mbid: t.album_mbid, mbid: t.mbid, type: 'track' },
      icon: <Cover src={t.cover_url} alt={t.album_title ?? t.title} size="sm" className="!h-9 !w-9" />,
      id: `track-${t.mbid}`,
      kind: 'track',
      libraryHref: null,
      meta: t.duration_ms ? formatDuration(Math.floor(t.duration_ms / 1000)) : undefined,
      subtitle: ['Трек', t.artist_name, t.album_title].filter(Boolean).join(' · '),
      title: t.title,
    })),
  ];
}

const groupIcon = { album: Disc3, artist: Mic2, track: Music2 } as const;
const groupTitle = { album: 'Альбомы', artist: 'Артисты', track: 'Треки' } as const;

function PaletteBody({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [rawActive, setActive] = useState(0);
  const listId = useId();
  const search = useSearch(query);
  const items = buildItems(search.data);
  const active = Math.min(rawActive, Math.max(items.length - 1, 0));
  const trimmed = query.trim();

  function openItem(item: Item | undefined) {
    if (item?.libraryHref) router.push(item.libraryHref);
    else if (trimmed) router.push(searchHref(trimmed));
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((active + delta + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active];
      if (e.shiftKey && item) void addToLibraryWithToast(item.add);
      else openItem(item);
    }
  }

  const showAll = trimmed ? (
    <button
      type="button"
      onClick={() => {
        router.push(searchHref(trimmed));
        onClose();
      }}
      className="text-accent shrink-0 text-sm font-medium whitespace-nowrap hover:underline"
    >
      Показать все результаты
    </button>
  ) : (
    <span className="text-muted text-xs">Начните вводить запрос</span>
  );

  return (
    <>
      <div className="border-divider dark:border-divider-dark flex items-center gap-3 border-b px-4 py-3">
        <SearchIcon className="text-gray h-5 w-5 shrink-0" aria-hidden />
        <input
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-activedescendant={items[active] ? `${listId}-${items[active].id}` : undefined}
          aria-autocomplete="list"
          aria-label="Поиск артистов, альбомов и треков"
          autoComplete="off"
          autoFocus
          maxLength={200}
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Поиск артистов, альбомов и треков…"
          className="!border-0 !bg-transparent !px-0 !py-1 !ring-0"
        />
        {search.status === 'loading' ? <Spinner className="text-gray h-4 w-4 shrink-0" /> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {search.status === 'error' && !search.data ? (
          <p className="text-muted px-3 py-6 text-center text-sm" role="alert">
            Поиск не удался{search.error ? `: ${search.error}` : ''}
          </p>
        ) : search.status === 'success' && items.length === 0 ? (
          <p className="text-muted px-3 py-6 text-center text-sm">Ничего не найдено</p>
        ) : (
          <ul
            id={listId}
            role="listbox"
            aria-label="Результаты поиска"
            className={cn('flex flex-col', search.stale && 'opacity-50')}
          >
            {items.map((item, i) => {
              const Icon = groupIcon[item.kind];
              const firstOfKind = i === 0 || items[i - 1].kind !== item.kind;
              return (
                <li key={item.id} role="presentation">
                  {firstOfKind ? (
                    <div className="text-muted flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs font-medium">
                      <Icon className="h-3.5 w-3.5" aria-hidden />
                      {groupTitle[item.kind]}
                    </div>
                  ) : null}
                  <div
                    id={`${listId}-${item.id}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => openItem(item)}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2',
                      i === active && 'bg-card dark:bg-card-dark',
                    )}
                  >
                    {item.icon}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{item.title}</span>
                      <span className="text-muted truncate text-xs">{item.subtitle}</span>
                    </div>
                    {item.meta ? <span className="text-muted font-mono text-xs">{item.meta}</span> : null}
                    {item.libraryHref || isInLibrary(search.data, item) ? (
                      <InLibraryBadge />
                    ) : (
                      <AddToLibraryButton
                        type={item.add.type}
                        mbid={item.add.mbid}
                        albumMbid={item.add.type === 'track' ? item.add.album_mbid : undefined}
                        tabIndex={-1}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-divider dark:border-divider-dark text-muted flex items-center justify-between gap-3 border-t px-4 py-2.5 text-xs">
        {showAll}
        <span className="hidden gap-3 whitespace-nowrap sm:flex">
          <span>
            <kbd className="font-mono">↑↓</kbd> выбор
          </span>
          <span>
            <kbd className="font-mono">Enter</kbd> открыть
          </span>
          <span>
            <kbd className="font-mono">Shift+Enter</kbd> добавить
          </span>
          <span>
            <kbd className="font-mono">Esc</kbd> закрыть
          </span>
        </span>
      </div>
    </>
  );
}

// У треков нет страницы в библиотеке, но `library_id` у них может быть — тогда кнопка не нужна.
function isInLibrary(data: ReturnType<typeof useSearch>['data'], item: Item) {
  if (!data) return false;
  if (item.kind === 'track') return data.tracks.some(t => `track-${t.mbid}` === item.id && t.library_id != null);
  return false;
}
