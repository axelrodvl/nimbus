import type * as Ariakit from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AudioQuality } from '@/components/library/audio-quality';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { apiErrorMessage } from '@/lib/api/error-message';
import type { SourceChoice } from '@/lib/api/sources';
import { useT } from '@/lib/i18n/provider';
import { chooseTrackSource, confirmTrackSource, retryTrackSearch } from '@/lib/sources/actions';
import { formatSize, sourceLabel } from '@/lib/sources/format';
import { useAlbumTorrents, useSourcesRefresh, useTorrentFiles, useTrackSources } from '@/lib/sources/hooks';

type Props = { store: Ariakit.DialogStore; trackId: number; albumId: number; title: string };
type Step = { name: 'sources' } | { name: 'torrents' } | { name: 'files'; torrentId: number };

const extOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';

/** Выбор источника трека: текущий и альтернативы → раздачи альбома → файлы раздачи. Содержимое — только пока открыто. */
export function TrackSourceDialog({ store, trackId, albumId, title }: Props) {
  const t = useT();
  return (
    <Dialog size="lg" store={store} title={t('dialog.title', { title })}>
      <Body albumId={albumId} store={store} title={title} trackId={trackId} />
    </Dialog>
  );
}

function Loading() {
  const t = useT();
  return (
    <p className="text-muted flex items-center gap-2 text-sm" role="status">
      <Spinner className="size-4" /> {t('common.loading')}
    </p>
  );
}

function Failed({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 text-sm" role="alert">
      <span className="text-danger">{t('common.loadFailed')}</span>
      <Button onClick={onRetry} size="sm" variant="secondary">
        {t('common.retry')}
      </Button>
    </div>
  );
}

function Body({ store, trackId, albumId }: Props) {
  const t = useT();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ name: 'sources' });
  const [busy, setBusy] = useState(false);
  useSourcesRefresh(albumId);

  async function run(action: () => Promise<unknown>, success: string, close: boolean) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      if (close) store.hide();
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }
  const ctx = { queryClient };
  const choose = (choice: SourceChoice) =>
    run(() => chooseTrackSource(trackId, albumId, choice, ctx), t('dialog.sourceChosen'), true);

  if (step.name === 'torrents') {
    return (
      <TorrentsStep
        onBack={() => setStep({ name: 'sources' })}
        onOpen={torrentId => setStep({ name: 'files', torrentId })}
        albumId={albumId}
      />
    );
  }
  if (step.name === 'files') {
    return (
      <FilesStep
        busy={busy}
        onBack={() => setStep({ name: 'torrents' })}
        onChoose={choose}
        torrentId={step.torrentId}
      />
    );
  }
  return (
    <SourcesStep
      busy={busy}
      onChoose={choose}
      onConfirm={sourceId =>
        run(() => confirmTrackSource(trackId, albumId, sourceId, ctx), t('dialog.confirmed'), false)
      }
      onPick={() => setStep({ name: 'torrents' })}
      onRetry={() => run(() => retryTrackSearch(trackId, albumId, ctx), t('sources.retryStarted'), true)}
      trackId={trackId}
    />
  );
}

function SourcesStep({
  trackId,
  busy,
  onChoose,
  onConfirm,
  onPick,
  onRetry,
}: {
  trackId: number;
  busy: boolean;
  onChoose: (choice: SourceChoice) => void;
  onConfirm: (sourceId: number) => void;
  onPick: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const query = useTrackSources(trackId);
  return (
    <>
      {query.isPending ? <Loading /> : null}
      {query.isError ? <Failed onRetry={() => void query.refetch()} /> : null}
      {query.data?.length === 0 ? <p className="text-muted text-sm">{t('dialog.noSources')}</p> : null}
      <ul className="flex flex-col gap-2" data-testid="source-list">
        {query.data?.map(s => (
          <li
            className="border-divider dark:border-divider-dark flex flex-col gap-1 rounded-lg border p-3"
            data-primary={s.is_primary}
            data-testid="source-item"
            key={s.id}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              {s.is_primary ? (
                <Check aria-label={t('dialog.chosen')} className="text-accent size-4" role="img" />
              ) : null}
              <span className="min-w-0 flex-1 truncate">{s.torrent.title}</span>
              <span className="bg-card dark:bg-card-dark rounded px-2 py-0.5 text-xs">
                {sourceLabel(s.torrent.source, t)}
              </span>
            </div>
            <p className="text-muted truncate font-mono text-xs">{s.path}</p>
            <AudioQuality className="justify-start" info={{ ext: extOf(s.path), transcoded: false }} />
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted">
                {t('dialog.match', { percent: Math.round(s.match_score * 100), size: formatSize(s.size_bytes, t) })}
              </span>
              {s.needs_confirmation ? (
                <span className="text-warning inline-flex items-center gap-1" data-testid="source-needs-check">
                  <AlertTriangle aria-hidden className="size-3.5" /> {t('dialog.check')}
                </span>
              ) : null}
              <span className="flex-1" />
              {s.needs_confirmation ? (
                <Button disabled={busy} onClick={() => onConfirm(s.id)} size="sm" variant="secondary">
                  {t('dialog.confirm')}
                </Button>
              ) : null}
              {!s.is_primary ? (
                <Button disabled={busy} onClick={() => onChoose({ source_id: s.id })} size="sm">
                  {t('dialog.choose')}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button onClick={onPick} variant="secondary">
          {t('dialog.pickFile')}
        </Button>
        <Button disabled={busy} onClick={onRetry} variant="ghost">
          {t('sources.retry')}
        </Button>
      </div>
    </>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      className="text-muted focus-visible:ring-accent/40 inline-flex items-center gap-1 self-start rounded text-sm hover:underline focus-visible:ring-2 focus-visible:outline-none"
      onClick={onClick}
      type="button"
    >
      <ArrowLeft aria-hidden className="size-4" /> {t('common.back')}
    </button>
  );
}

function TorrentsStep({
  albumId,
  onBack,
  onOpen,
}: {
  albumId: number;
  onBack: () => void;
  onOpen: (torrentId: number) => void;
}) {
  const t = useT();
  const query = useAlbumTorrents(albumId);
  return (
    <>
      <BackButton onClick={onBack} />
      {query.isPending ? <Loading /> : null}
      {query.isError ? <Failed onRetry={() => void query.refetch()} /> : null}
      {query.data?.length === 0 ? <p className="text-muted text-sm">{t('dialog.noTorrents')}</p> : null}
      <ul className="flex flex-col gap-2">
        {query.data?.map(item => (
          <li key={item.torrent.id}>
            <button
              className="border-divider dark:border-divider-dark hover:bg-card dark:hover:bg-card-dark focus-visible:ring-accent/40 w-full rounded-lg border px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
              data-testid="dialog-torrent"
              onClick={() => onOpen(item.torrent.id)}
              type="button"
            >
              <span className="font-medium">{item.torrent.title}</span>
              <span className="text-muted block text-xs">
                {t('dialog.filesCount', { count: item.files_count, source: sourceLabel(item.torrent.source, t) })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function FilesStep({
  torrentId,
  busy,
  onBack,
  onChoose,
}: {
  torrentId: number;
  busy: boolean;
  onBack: () => void;
  onChoose: (choice: SourceChoice) => void;
}) {
  const t = useT();
  const query = useTorrentFiles(torrentId);
  return (
    <>
      <BackButton onClick={onBack} />
      {query.isPending ? <Loading /> : null}
      {query.isError ? <Failed onRetry={() => void query.refetch()} /> : null}
      {query.data?.length === 0 ? <p className="text-muted text-sm">{t('dialog.filesUnknown')}</p> : null}
      <ul className="flex flex-col gap-1">
        {query.data?.map(f => (
          <li key={f.file_index}>
            <button
              className="hover:bg-card dark:hover:bg-card-dark focus-visible:ring-accent/40 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
              data-testid="dialog-file"
              disabled={busy}
              onClick={() => onChoose({ file_index: f.file_index, torrent_id: torrentId })}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
              <span className="text-muted font-mono">{formatSize(f.size_bytes, t)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
