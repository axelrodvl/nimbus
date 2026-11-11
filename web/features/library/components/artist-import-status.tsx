'use client';

import { Loader2, TriangleAlert } from 'lucide-react';
import { useTransition } from 'react';
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

// Статус импорта дискографии: идёт / ждём MusicBrainz (с повтором) / не удалось (с кнопкой «Повторить»).
export function ArtistImportStatus({ artistId, status }: { artistId: number; status: Import }) {
  const t = useT();
  const [pending, start] = useTransition();
  const params = { attempt: status.attempt, max: status.max_attempts };

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
      </div>
    );
  }

  const retrying = status.state === 'retrying';
  const text = retrying
    ? t('artist.import.retrying', { ...params, minutes: minutesUntil(status.retry_at) })
    : status.attempt > 1
      ? t('artist.import.attempt', params)
      : t('artist.importing');
  return (
    <p
      className="text-muted flex items-center gap-2 text-sm"
      data-testid="artist-import"
      data-state={status.state}
      role="status"
      title={status.error ?? undefined}
    >
      {retrying ? (
        <TriangleAlert className="text-warning h-4 w-4 shrink-0" aria-hidden />
      ) : (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      )}
      {text}
    </p>
  );
}
