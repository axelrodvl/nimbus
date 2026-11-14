'use client';

import { ChevronDown, Loader2, TriangleAlert } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { retryArtistImport } from '@/app/actions/library';
import { Button } from '@/components/ui/button';
import type { Schemas } from '@/lib/api/client';
import { useT } from '@/providers/i18n-provider';

type Import = NonNullable<Schemas['ArtistDto']['import']>;

/** Минуты до следующей попытки (не меньше одной). */
function minutesUntil(iso: string | null | undefined) {
  if (!iso) return 1;
  return Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000));
}

type Progress = NonNullable<Import['progress']>;

/** Одна строка о том, что делает импорт прямо сейчас. */
function progressLine(t: ReturnType<typeof useT>, p: Progress) {
  if (p.phase === 'albums')
    return t('artist.import.step.albums', { done: p.done, title: p.current ?? '…', total: p.total });
  if (p.phase === 'discover') return t('artist.import.step.discover', { imported: p.imported });
  // Фаза MusicBrainz: страницы списка групп/релизов (done из total), пока total неизвестен — без числа.
  const pages = p.total > 0 ? ` ${p.done}/${p.total}` : '';
  return `${t('artist.import.step.groups')}${pages}`;
}

/** Живая строка «что именно сейчас происходит» (текст от бэкенда): виден, даже когда журнал свёрнут. */
function liveDetail(p: Progress | null) {
  return p && p.phase === 'groups' && p.current ? p.current : null;
}

/** Журнал шагов (по нажатию): новые записи сверху. Текст — от бэкенда, на английском. */
function ImportLog({ log }: { log: Progress['log'] }) {
  return (
    <ol
      className="text-muted bg-card dark:bg-card-dark dark:text-gray max-h-64 w-full max-w-xl overflow-y-auto rounded-md p-3 text-left font-mono text-xs"
      data-testid="artist-import-log"
    >
      {[...log].reverse().map((e, i) => (
        <li key={`${e.at}-${i}`} className="py-0.5">
          <time className="opacity-60" dateTime={e.at}>
            {new Date(e.at).toLocaleTimeString()}
          </time>{' '}
          {e.text}
        </li>
      ))}
    </ol>
  );
}

// Статус импорта дискографии: идёт / ждём MusicBrainz (с повтором) / не удалось (с кнопкой «Повторить»).
export function ArtistImportStatus({ artistId, status }: { artistId: number; status: Import }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const params = { attempt: status.attempt, max: status.max_attempts };
  const progress = status.progress ?? null;
  const hasLog = (progress?.log.length ?? 0) > 0;

  if (status.state === 'failed') {
    return (
      <div className="flex flex-col items-start gap-2" data-testid="artist-import" data-state="failed" role="status">
        <p className="text-danger flex items-center gap-2 text-sm" title={status.error ?? undefined}>
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
          {t('artist.import.failed', params)}
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await retryArtistImport(artistId);
              if (r.ok) toast.success(t('artist.import.restarted'));
              else toast.error(r.message);
            })
          }
        >
          {t('artist.import.retry')}
        </Button>
        {hasLog ? (
          <DetailsToggle open={open} onToggle={() => setOpen(o => !o)} label={t('artist.import.details')} />
        ) : null}
        {open && progress ? <ImportLog log={progress.log} /> : null}
      </div>
    );
  }

  const retrying = status.state === 'retrying';
  const text = retrying
    ? t('artist.import.retrying', { ...params, minutes: minutesUntil(status.retry_at) })
    : progress
      ? progressLine(t, progress)
      : status.attempt > 1
        ? t('artist.import.attempt', params)
        : t('artist.importing');
  const icon = retrying ? (
    <TriangleAlert className="text-warning h-4 w-4 shrink-0" aria-hidden />
  ) : (
    <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
  );
  return (
    <div
      className="flex max-w-full flex-col items-start gap-2"
      data-testid="artist-import"
      data-state={status.state}
      role="status"
      title={status.error ?? undefined}
    >
      {hasLog ? (
        <button
          type="button"
          className="text-muted hover:text-foreground flex max-w-full items-center gap-2 text-left text-sm"
          aria-expanded={open}
          title={t('artist.import.details')}
          onClick={() => setOpen(o => !o)}
        >
          {icon}
          <span className="min-w-0 truncate">{text}</span>
          <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </button>
      ) : (
        <p className="text-muted flex items-center gap-2 text-sm">
          {icon}
          {text}
        </p>
      )}
      {liveDetail(progress) ? (
        <p className="text-muted/80 max-w-full truncate text-xs" data-testid="artist-import-live">
          {liveDetail(progress)}
        </p>
      ) : null}
      {progress && progress.phase === 'groups' && progress.total > 0 ? (
        <div className="bg-card dark:bg-card-dark h-1 w-full max-w-xl overflow-hidden rounded-full" aria-hidden>
          <div
            className="bg-accent h-full transition-[width]"
            style={{ width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` }}
          />
        </div>
      ) : null}
      {open && progress ? <ImportLog log={progress.log} /> : null}
    </div>
  );
}

function DetailsToggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      className="text-muted hover:text-foreground flex items-center gap-1 text-xs"
      aria-expanded={open}
      onClick={onToggle}
    >
      {label}
      <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
    </button>
  );
}
