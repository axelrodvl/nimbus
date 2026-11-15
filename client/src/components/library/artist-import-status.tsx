import { Check, Hourglass, Loader2, TriangleAlert } from 'lucide-react';
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

/** Шаги импорта по порядку; `queue` — ожидание слота, остальные — фазы бэкенда. */
const STEPS = ['queue', 'groups', 'albums', 'discover'] as const;
type Step = (typeof STEPS)[number];

/** Индекс текущего шага: очередь → MusicBrainz (пока прогресса нет — тоже он) → альбомы → поиск источников. */
function currentStep(status: ArtistImport): number {
  if (status.state === 'queued') return 0;
  return STEPS.indexOf(status.progress?.phase ?? 'groups');
}

/** Доля 0–100 для полосы шага или `null`, если считать нечего. */
function percent(done: number, total: number) {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
}

/** Подробности текущего шага: счётчик, текущий элемент, полоса. */
function StepDetail({ step, progress, t }: { step: Step; progress: Progress | null; t: TFn }) {
  if (!progress) return null;
  if (step === 'groups') {
    const pct = percent(progress.done, progress.total);
    return (
      <>
        {pct !== null ? <span className="tabular-nums">{`${progress.done}/${progress.total}`}</span> : null}
        {progress.current ? (
          <span className="block max-w-full truncate" data-testid="artist-import-live">
            {progress.current}
          </span>
        ) : null}
        {pct !== null ? <Bar pct={pct} /> : null}
      </>
    );
  }
  if (step === 'albums') {
    const pct = percent(progress.done, progress.total);
    return (
      <>
        <span className="tabular-nums">{`${progress.done}/${progress.total}`}</span>
        {progress.current ? <span className="block max-w-full truncate">{progress.current}</span> : null}
        {pct !== null ? <Bar pct={pct} /> : null}
      </>
    );
  }
  if (step === 'discover') return <span>{t('count.albums', { count: progress.imported })}</span>;
  return null;
}

function Bar({ pct }: { pct: number }) {
  return (
    <span
      aria-hidden
      className="bg-card dark:bg-card-dark mt-1.5 block h-1 w-full max-w-xs overflow-hidden rounded-full"
    >
      <span className="bg-accent block h-full transition-[width]" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Точка шага: пройден — галочка, текущий — крутящийся индикатор, впереди — пустой кружок. */
function Dot({ state }: { state: 'done' | 'active' | 'todo' }) {
  if (state === 'done')
    return (
      <span className="bg-accent flex size-6 items-center justify-center rounded-full text-white">
        <Check aria-hidden className="size-3.5" strokeWidth={3} />
      </span>
    );
  if (state === 'active')
    return (
      <span className="border-accent text-accent flex size-6 items-center justify-center rounded-full border-2">
        <Loader2 aria-hidden className="size-3.5 animate-spin" />
      </span>
    );
  return <span className="border-muted/40 size-6 rounded-full border-2" />;
}

/** Вертикальный степпер импорта (как статус заказа): пройденные шаги, текущий с подробностями, будущие. */
function ImportSteps({ status, t }: { status: ArtistImport; t: TFn }) {
  const current = currentStep(status);
  const progress = status.progress ?? null;
  return (
    <ol className="flex w-full max-w-xl flex-col text-left" data-testid="artist-import-steps">
      {STEPS.map((step, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'todo';
        return (
          <li
            aria-current={state === 'active' ? 'step' : undefined}
            className="flex gap-3"
            data-step={step}
            data-step-state={state}
            key={step}
          >
            <div className="flex flex-col items-center">
              <Dot state={state} />
              {i < STEPS.length - 1 ? (
                <span className={`my-1 w-0.5 flex-1 rounded-full ${i < current ? 'bg-accent' : 'bg-muted/25'}`} />
              ) : null}
            </div>
            <div className={`min-w-0 flex-1 pb-4 ${i === STEPS.length - 1 ? 'pb-0' : ''}`}>
              <p
                className={`text-sm leading-6 ${state === 'todo' || state === 'done' ? 'text-muted' : 'font-medium'}`}
              >
                {t(`artist.import.steps.${step}`)}
              </p>
              {state === 'active' ? (
                <div className="text-muted mt-0.5 text-xs">
                  <StepDetail progress={progress} step={step} t={t} />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
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

/** Статус импорта дискографии: шаги (очередь → MusicBrainz → альбомы → источники) / ждём MusicBrainz (с повтором) / не удалось (с кнопкой «Повторить»). */
export function ArtistImportStatus({ status, onRetry, now }: Props) {
  const t = useT();
  const [mountedAt] = useState(Date.now);
  const [pending, setPending] = useState(false);
  const params = { attempt: status.attempt, max: status.max_attempts };

  if (status.state === 'failed') {
    return (
      <div
        className="flex w-full min-w-0 flex-col items-start gap-2"
        data-state="failed"
        data-testid="artist-import"
        role="status"
      >
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
      </div>
    );
  }

  if (status.state === 'retrying') {
    return (
      <div
        className="flex w-full min-w-0 flex-col items-start gap-2"
        data-state="retrying"
        data-testid="artist-import"
        role="status"
        title={status.error ?? undefined}
      >
        <p className="text-muted flex min-w-0 items-center gap-2 text-sm">
          <TriangleAlert aria-hidden className="text-warning-fg size-4 shrink-0" />
          {t('artist.import.retrying', { ...params, minutes: minutesUntil(status.retry_at, now ?? mountedAt) })}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex w-full max-w-full min-w-0 flex-col items-start gap-3"
      data-state={status.state}
      data-testid="artist-import"
      role="status"
      title={status.error ?? undefined}
    >
      {status.state === 'queued' ? (
        <p className="text-muted flex min-w-0 items-center gap-2 text-sm">
          <Hourglass aria-hidden className="size-4 shrink-0" />
          {t('artist.import.queued')}
        </p>
      ) : status.attempt > 1 && !status.progress ? (
        <p className="text-muted text-sm">{t('artist.import.attempt', params)}</p>
      ) : null}
      <ImportSteps status={status} t={t} />
    </div>
  );
}
