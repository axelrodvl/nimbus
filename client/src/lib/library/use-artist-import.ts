import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getArtistImport, type ArtistImport } from '@/lib/api/library';
import { appData } from '@/lib/app-data';
import { useLiveEvent } from '@/lib/live/hooks';

/** Пауза между обновлениями статуса по событиям: серия событий — один запрос. */
export const IMPORT_REFRESH_DEBOUNCE_MS = 1000;

export const artistImportKey = (id: number) => ['artist-import', id] as const;

/**
 * Подробности импорта дискографии артиста (`GET /api/artists/{id}`: попытка, ошибка, время повтора, прогресс).
 * Грубое состояние (`artist.import`) приходит из store в первом кадре; запрос идёт только пока импорт не
 * завершён (`enabled`), иначе экран артиста не обращается к сети. Обновляется по событиям `library.changed` (артист) и `job.progress` (его альбомы) с задержкой 1 с.
 */
export function useArtistImport(id: number, enabled: boolean): { data: ArtistImport | null | undefined } {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const query = useQuery({ enabled, queryFn: () => getArtistImport(id), queryKey: artistImportKey(id), staleTime: 0 });

  const refresh = () => {
    if (!enabled || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({ queryKey: artistImportKey(id) });
    }, IMPORT_REFRESH_DEBOUNCE_MS);
  };
  useLiveEvent<{ type: string; entity?: string; id?: number }>('library.changed', e => {
    if (e.entity === 'artist' && e.id === id) refresh();
  });
  useLiveEvent<{ type: string; album_id?: number }>('job.progress', e => {
    if (e.album_id !== undefined && appData().library.getState().albumsByArtist.get(id)?.includes(e.album_id))
      refresh();
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
  return { data: enabled ? query.data : undefined };
}
