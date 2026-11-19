import { Search as SearchIcon, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigationType, useSearchParams } from 'react-router';
import { PageLayout } from '@/components/page-layout';
import { SearchResults } from '@/components/search/search-results';
import { useT } from '@/lib/i18n/provider';
import { useOnline } from '@/lib/live/hooks';
import { LOCAL_LIMIT } from '@/lib/search/query';
import { useRemoteSearch } from '@/lib/search/use-remote-search';
import { scrollRoot } from '@/lib/nav/scroll-top';
import { restoreScrollOnce } from '@/lib/nav/use-scroll-restoration';
import { flushSearchSession, rememberQuery, rememberScroll, searchSession } from '@/lib/search/session';
import { useMbidIndex, useSearchLocal } from '@/lib/store/hooks';

/** Настольное устройство с точным указателем: автофокус на телефоне открыл бы клавиатуру поверх результатов. */
const wantsAutofocus = () => globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false;

/** `/search?q=…`: локальные совпадения сразу, MusicBrainz — по сети. Запрос живёт в URL (replace, без истории). */
export function SearchScreen() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const [value, setValue] = useState(urlQuery);
  const input = useRef<HTMLInputElement>(null);
  const online = useOnline();
  const local = useSearchLocal(value, LOCAL_LIMIT);
  const remote = useRemoteSearch(value, online);
  const index = useMbidIndex();

  // Ссылка из истории или палитры меняет `?q=` снаружи — поле следует за ней (набор текста URL уже совпадает).
  const [prevUrl, setPrevUrl] = useState(urlQuery);
  if (urlQuery !== prevUrl) {
    setPrevUrl(urlQuery);
    if (urlQuery !== value) setValue(urlQuery);
  }
  // Запрос в сессии обновляем в эффекте, а не при рендере: это `setState` внешнего store, его подписчики (вкладка
  // «Поиск» в оболочке) иначе обновлялись бы посреди рендера другого компонента.
  useEffect(() => rememberQuery(urlQuery), [urlQuery]);
  // Вернулись на поиск вкладкой (переход вперёд на тот же запрос) — прокрутка как была. «Назад» прокрутку
  // восстанавливает оболочка сама. Layout-эффект — раньше эффекта оболочки, который иначе прокрутил бы наверх.
  const navigation = useNavigationType();
  useLayoutEffect(() => {
    const saved = searchSession.getState();
    if (navigation !== 'POP' && saved.query === urlQuery && urlQuery.trim()) restoreScrollOnce(saved.scroll);
    rememberQuery(urlQuery);
    // Автофокус — только на пустом поиске: вернувшись к результатам, клавиатура не нужна.
    if (wantsAutofocus() && !urlQuery) input.current?.focus();
    // Только при входе на экран.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Прокрутку запоминаем по ходу: при уходе с экрана контейнер уже может быть подрезан под новый экран.
  useEffect(() => {
    const root = scrollRoot();
    if (!root) return;
    // Экран уже снят (контейнер подрезан под следующий) — это не прокрутка поиска.
    const onScroll = () => {
      if (input.current?.isConnected) rememberScroll(root.scrollTop);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      flushSearchSession();
    };
  }, []);

  function onChange(next: string) {
    setValue(next);
    rememberQuery(next);
    setParams(next.trim() ? { q: next } : {}, { replace: true });
  }

  return (
    <PageLayout title={t('nav.search')}>
      <form
        aria-label={t('search.formLabel')}
        className="relative mb-8 flex items-center"
        onSubmit={e => e.preventDefault()}
        role="search"
      >
        <SearchIcon
          aria-hidden
          className="text-gray pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2"
        />
        <input
          aria-label={t('palette.inputLabel')}
          autoComplete="off"
          className="border-divider dark:border-divider-dark bg-card/50 dark:bg-card-dark/50 focus-visible:ring-accent/40 w-full appearance-none rounded-full border py-3 pr-12 pl-12 text-base focus-visible:ring-2 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          maxLength={200}
          name="q"
          onChange={e => onChange(e.target.value)}
          placeholder={t('search.prompt.title')}
          ref={input}
          type="search"
          value={value}
        />
        {value ? (
          <button
            aria-label={t('search.historyClear')}
            className="text-gray hover:text-black dark:hover:text-white absolute top-1/2 right-3 flex size-8 -translate-y-1/2 items-center justify-center rounded-full"
            data-testid="search-clear"
            onClick={() => {
              onChange('');
              input.current?.focus();
            }}
            type="button"
          >
            <X aria-hidden className="size-5" />
          </button>
        ) : null}
      </form>
      <SearchResults index={index} local={local} online={online} query={value} remote={remote} />
    </PageLayout>
  );
}
