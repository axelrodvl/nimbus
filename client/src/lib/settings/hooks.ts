import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api/errors';
import { apiErrorMessage as errorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { fetchSettings, fetchStorage, putSettings, retryMissing } from '@/lib/api/settings';
import { leafPaths, mergePatch } from './paths';
import type { Patch, ServerSettings } from './types';

export const SETTINGS_KEY = ['settings'] as const;
export const STORAGE_KEY = ['storage'] as const;
const MUTATION_KEY = ['settings', 'update'] as const;

/** Настройки сервера (`GET /api/settings`). */
export const useSettings = () =>
  useQuery({ queryFn: ({ signal }) => fetchSettings(signal), queryKey: SETTINGS_KEY, staleTime: 30_000 });

/** Заполненность хранилища (`GET /api/storage`). */
export const useStorage = (enabled = true) =>
  useQuery({ enabled, queryFn: ({ signal }) => fetchStorage(signal), queryKey: STORAGE_KEY, staleTime: 10_000 });

/**
 * Частичный патч `PUT /api/settings`. Кэш обновляется сразу, при ошибке откатывается к снимку.
 * Мутации идут по очереди (`scope`), а ответ более раннего запроса не затирает более новое значение:
 * кэш заменяется ответом сервера только когда в очереди не осталось других сохранений.
 */
export function useUpdateSettings() {
  const qc = useQueryClient();
  const othersPending = () => qc.isMutating({ mutationKey: MUTATION_KEY }) > 1;
  return useMutation({
    mutationFn: (patch: Patch) => putSettings(patch),
    mutationKey: MUTATION_KEY,
    onMutate: async patch => {
      await qc.cancelQueries({ queryKey: SETTINGS_KEY });
      const previous = qc.getQueryData<ServerSettings>(SETTINGS_KEY);
      if (previous) qc.setQueryData<ServerSettings>(SETTINGS_KEY, mergePatch(previous, patch));
      return { previous };
    },
    onError: (_e, _patch, ctx) => {
      if (ctx?.previous && !othersPending()) qc.setQueryData(SETTINGS_KEY, ctx.previous);
      if (!othersPending()) void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
    onSuccess: data => {
      if (!othersPending()) qc.setQueryData(SETTINGS_KEY, data);
      void qc.invalidateQueries({ queryKey: STORAGE_KEY });
    },
    scope: { id: 'settings' },
  });
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Сохранение настроек раздела: статус для индикатора («Сохраняется… / Сохранено / Ошибка») и ошибки по полям.
 * `save` возвращает `true`, если сервер принял патч. Ошибка 400 привязывается к полю (`ApiError.field`, иначе
 * к единственному полю патча), прочие ошибки — toast.
 */
export function useSettingsSave() {
  const t = useT();
  const mutation = useUpdateSettings();
  const mutateAsync = mutation.mutateAsync;
  const inflight = useRef(0);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useCallback(
    async (patch: Patch): Promise<boolean> => {
      const paths = leafPaths(patch);
      inflight.current += 1;
      setStatus('saving');
      setErrors(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => !paths.includes(k))));
      try {
        const saved = await mutateAsync(patch);
        inflight.current -= 1;
        if (inflight.current === 0) setStatus('saved');
        if (saved.suggest_retry_missing) {
          toast.info(t('settings.retryMissing.suggest'), {
            action: {
              label: t('settings.retryMissing.action'),
              onClick: () =>
                void retryMissing().then(
                  n => toast.success(t('settings.retryMissing.started', { count: n })),
                  (e: unknown) => toast.error(errorMessage(e, t)),
                ),
            },
            duration: 15_000,
          });
        }
        return true;
      } catch (e) {
        inflight.current -= 1;
        setStatus('error');
        if (e instanceof ApiError && e.status === 400) {
          const field = e.field ?? (paths.length === 1 ? paths[0] : '');
          setErrors(prev => ({ ...prev, [field ?? '']: e.message }));
        } else {
          toast.error(errorMessage(e, t));
        }
        return false;
      }
    },
    [mutateAsync, t],
  );

  return { errors, save, status };
}
