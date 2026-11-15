import { ChevronDown, Hourglass, Loader2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ArtistImport } from '@/lib/api/library';
import { useT, type TFn } from '@/lib/i18n/provider';

type Progress = NonNullable<ArtistImport['progress']>;

/** Минуты до следующей попытки (не меньше одной). */
function minutesUntil(iso: string | null | undefined, now: number) {
  if (!iso) return 1;
  return Math.max(1, Math.ceil((new Date(iso).getTime() - now) / 60_000));
}

/** Одна строка о том, что делает импорт прямо сейчас. */
function progressLine(t: TFn, p: Progress) {
  if (p.phase === 'albums') return t('artist.import.step.albums', { done: p.done, title: p.current ?? '…', total: p.total });
  if (p.phase === 'discover') return t('artist.import.step.discover', { imported: p.imported });
  // Фаза MusicBrainz: страницы списка групп/релизов (done из total), пока total неизвестен — без числа.
  const pages = p.total > 0 ? ` ${p.done}/${p.total}` : '';
  return `${t('artist.import.step.groups')}${pages}`;
}

/** Живая строка «что именно сейчас происходит» (текст от бэкенда): виден, даже когда журнал свёрнут. */
const liveDetail = (p: Progress | null) => (p && p.phase === 'groups' && p.current ? p.current : null);

/** Журнал шагов (по нажатию): новые записи сверху. Текст — от бэкенда, на английском. */
function ImportLog({ log }: { log: Progress['log'] }) {
  return (
    <ol
      className="text-muted bg-card dark:bg-card-dark dark:text-gray max-h-64 w-full max-w-xl overflow-y-auto rounded-md p-3 text-left font-mono text-xs"
      data-testid="artist-import-log"
    >
      {[...log].reverse().map((e, i) => (
        <li className="py-0.5" key={`${e.at}-${i}`}>
          <time className="opacity-60" dateTime={e.at}>
            {new Date(e.at).toLocaleTimeString()}
          </time>{' '}
          {e.text}
        </li>
      ))}
    </ol>
  );
}

type Props = {
  status: ArtistImport;
  /** Повторить импорт (кнопка видна при `failed`). Бросает ошибку — её показывает вызывающий. */
  onRetry: () => Promise<void>;
  /** Текущее время (для тестов). */
  now?: number;
};

/** Статус импорта дискографии: идёт / в очереди / ждём MusicBrainz (с повтором) / не удалось (с кнопкой «Повторить»). */
export function ArtistImportStatus({ status, onRetry, now }: Props) {
  const t = useT();
  const [mountedAt] = useState(Date.now);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const params = { attempt: status.attempt, max: status.max_attempts };
  const progress = status.progress ?? null;
  const hasLog = (progress?.log.length ?? 0) > 0;

  if (status.state === 'failed') {
    return (
      <div className="flex flex-col items-start gap-2" data-state="failed" data-testid="artist-import" role="status">
        <p className="text-danger-fg flex items-center gap-2 text-sm" title={status.error ?? undefined}>
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          {t('artist.import.failed', params)}
        </p>
        <Button
          disabled={pending}
          onClick={() => {
            setPending(true);
            void onRetry().finally(() => setPending(false));
          }}
          size="sm"
          variant="secondary"
        >
          {t('artist.import.retry')}
        </Button>
        {hasLog ? <DetailsToggle label={t('artist.import.details')} onToggle={() => setOpen(o => !o)} open={open} /> : null}
        {open && progress ? <ImportLog log={progress.log} /> : null}
      </div>
    );
  }

  const retrying = status.state === 'retrying';
  const queued = status.state === 'queued';
  const text = retrying
    ? t('artist.import.retrying', { ...params, minutes: minutesUntil(status.retry_at, now ?? mountedAt) })
    : queued
      ? t('artist.import.queued')
      : progress
        ? progressLine(t, progress)
        : status.attempt > 1
          ? t('artist.import.attempt', params)
          : t('artist.importing');
  const icon = retrying ? (
    <TriangleAlert aria-hidden className="text-warning-fg size-4 shrink-0" />
  ) : queued ? (
    <Hourglass aria-hidden className="size-4 shrink-0" />
  ) : (
    <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
  );
  return (
    <div
      className="flex max-w-full flex-col items-start gap-2"
      data-state={status.state}
      data-testid="artist-import"
      role="status"
      title={status.error ?? undefined}
    >
      {hasLog ? (
        <button
          aria-expanded={open}
          className="text-muted hover:text-foreground flex max-w-full items-center gap-2 text-left text-sm"
          onClick={() => setOpen(o => !o)}
          title={t('artist.import.details')}
          type="button"
        >
          {icon}
          <span className="min-w-0 truncate">{text}</span>
          <ChevronDown aria-hidden className={`size-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
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
        <div aria-hidden className="bg-card dark:bg-card-dark h-1 w-full max-w-xl overflow-hidden rounded-full">
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
      aria-expanded={open}
      className="text-muted hover:text-foreground flex items-center gap-1 text-xs"
      onClick={onToggle}
      type="button"
    >
      {label}
      <ChevronDown aria-hidden className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}
