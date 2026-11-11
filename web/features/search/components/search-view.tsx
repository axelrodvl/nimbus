'use client';

import { Search as SearchIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import { SearchResults } from '@/features/search/components/search-results';
import { useSearch } from '@/hooks/use-search';
import type { Route } from 'next';

export function searchHref(query: string) {
  return (query ? `/search?q=${encodeURIComponent(query)}` : '/search') as Route;
}

// Поле ввода синхронизируется с `?q=` через router.replace (без перезагрузки и прокрутки).
export function SearchView() {
  const router = useRouter();
  const params = useSearchParams();
  const inputId = useId();
  const [value, setValue] = useState(() => params.get('q') ?? '');
  const search = useSearch(value);

  return (
    <>
      <form
        role="search"
        onSubmit={e => e.preventDefault()}
        className="relative mb-8 flex items-center"
        aria-label="Поиск по MusicBrainz"
      >
        <SearchIcon className="text-gray pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2" />
        <input
          id={inputId}
          type="search"
          name="q"
          value={value}
          autoComplete="off"
          autoFocus
          aria-label="Поиск артистов, альбомов и треков"
          placeholder="Что хотите послушать?"
          maxLength={200}
          onChange={e => {
            setValue(e.target.value);
            router.replace(searchHref(e.target.value.trim()), { scroll: false });
          }}
          className="!rounded-full !py-3 !pr-4 !pl-12 !text-base"
        />
      </form>
      <SearchResults
        status={search.status}
        data={search.data}
        stale={search.stale}
        error={search.error}
        query={value.trim()}
        onRetry={search.retry}
      />
    </>
  );
}
