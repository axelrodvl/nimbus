'use client';

import * as Ariakit from '@ariakit/react';
import { AlertTriangle, ArrowLeft, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  confirmTrackSource,
  loadAlbumTorrents,
  loadTorrentFiles,
  loadTrackSources,
  retryTrack,
  setTrackSource,
} from '@/app/actions/sources';
import type { SourceChoice } from '@/app/actions/sources';
import { Button } from '@/components/ui/button';
import { SOURCE_LABEL, formatSize } from '@/features/sources/format';
import type { Schemas } from '@/lib/api/client';

type Props = {
  store: Ariakit.DialogStore;
  trackId: number;
  albumId: number;
  title: string;
};

type Step = 'sources' | 'torrents' | 'files';

// Содержимое монтируется заново при каждом открытии (`unmountOnHide`), поэтому состояние сбрасывается само.
export function TrackSourceDialog(props: Props) {
  const { store, title } = props;
  return (
    <Ariakit.Dialog
      store={store}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      backdrop={<div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />}
      aria-label={`Источник трека: ${title}`}
      className="border-divider dark:border-divider-dark fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-2xl border bg-white p-6 shadow-2xl outline-none dark:bg-black"
      unmountOnHide
    >
      <DialogBody {...props} />
    </Ariakit.Dialog>
  );
}

function DialogBody({ store, trackId, albumId, title }: Props) {
  const [step, setStep] = useState<Step>('sources');
  const [sources, setSources] = useState<Schemas['TrackSourceDto'][] | null>(null);
  const [torrents, setTorrents] = useState<Schemas['AlbumTorrentDto'][] | null>(null);
  const [files, setFiles] = useState<Schemas['TorrentFileDto'][] | null>(null);
  const [torrentId, setTorrentId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const r = await loadTrackSources(trackId);
    if (r.ok) setSources(r.sources);
    else toast.error(r.message);
  }

  useEffect(() => {
    // Загрузка данных при открытии: setState происходит после await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId]);

  async function run(action: () => Promise<{ ok: boolean; message?: string }>, success: string, close = false) {
    setBusy(true);
    const r = await action();
    setBusy(false);
    if (!r.ok) return void toast.error(r.message ?? 'Не удалось выполнить');
    toast.success(success);
    if (close) store.hide();
    else await reload();
  }

  const choose = (choice: SourceChoice) => run(() => setTrackSource(trackId, albumId, choice), 'Источник выбран', true);

  async function openTorrents() {
    setStep('torrents');
    if (torrents === null) {
      const r = await loadAlbumTorrents(albumId);
      if (r.ok) setTorrents(r.torrents);
      else toast.error(r.message);
    }
  }

  async function openFiles(id: number) {
    setTorrentId(id);
    setFiles(null);
    setStep('files');
    const r = await loadTorrentFiles(id);
    if (r.ok) setFiles(r.files);
    else toast.error(r.message);
  }

  return (
    <>
      <Ariakit.DialogHeading className="text-lg font-semibold">Источник трека «{title}»</Ariakit.DialogHeading>

      {step === 'sources' ? (
        <>
          {sources === null ? <p className="text-muted text-sm">Загрузка…</p> : null}
          {sources?.length === 0 ? <p className="text-muted text-sm">Источников нет.</p> : null}
          <ul className="flex flex-col gap-2" data-testid="source-list">
            {sources?.map(s => (
              <li
                key={s.id}
                data-testid="source-item"
                data-primary={s.is_primary}
                className="border-divider dark:border-divider-dark flex flex-col gap-1 rounded-lg border p-3"
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  {s.is_primary ? <Check className="text-accent h-4 w-4" aria-label="Выбран" /> : null}
                  <span className="min-w-0 flex-1 truncate">{s.torrent.title}</span>
                  <span className="bg-card dark:bg-card-dark rounded px-2 py-0.5 text-xs">
                    {SOURCE_LABEL[s.torrent.source] ?? s.torrent.source}
                  </span>
                </div>
                <p className="text-muted truncate font-mono text-xs">{s.path}</p>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted">
                    {formatSize(s.size_bytes)} · совпадение {Math.round(s.match_score * 100)}%
                  </span>
                  {s.needs_confirmation ? (
                    <span className="text-warning inline-flex items-center gap-1">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> проверьте
                    </span>
                  ) : null}
                  <span className="flex-1" />
                  {s.needs_confirmation ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => run(() => confirmTrackSource(trackId, albumId, s.id), 'Подтверждено')}
                    >
                      Подтвердить
                    </Button>
                  ) : null}
                  {!s.is_primary ? (
                    <Button size="sm" disabled={busy} onClick={() => choose({ source_id: s.id })}>
                      Выбрать
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={openTorrents}>
              Выбрать файл вручную
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => run(() => retryTrack(trackId, albumId), 'Поиск запущен заново', true)}
            >
              Повторить поиск
            </Button>
          </div>
        </>
      ) : null}

      {step === 'torrents' ? (
        <>
          <BackButton onClick={() => setStep('sources')} />
          {torrents === null ? <p className="text-muted text-sm">Загрузка…</p> : null}
          {torrents?.length === 0 ? <p className="text-muted text-sm">У альбома нет раздач.</p> : null}
          <ul className="flex flex-col gap-2">
            {torrents?.map(t => (
              <li key={t.torrent.id}>
                <button
                  type="button"
                  onClick={() => openFiles(t.torrent.id)}
                  className="border-divider dark:border-divider-dark hover:bg-card dark:hover:bg-card-dark w-full rounded-lg border px-3 py-2 text-left text-sm"
                >
                  <span className="font-medium">{t.torrent.title}</span>
                  <span className="text-muted block text-xs">
                    {SOURCE_LABEL[t.torrent.source] ?? t.torrent.source} · {t.files_count} файлов
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {step === 'files' && torrentId !== null ? (
        <>
          <BackButton onClick={() => setStep('torrents')} />
          {files === null ? <p className="text-muted text-sm">Загрузка…</p> : null}
          {files?.length === 0 ? <p className="text-muted text-sm">Файлы ещё неизвестны.</p> : null}
          <ul className="flex flex-col gap-1">
            {files?.map(f => (
              <li key={f.file_index}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => choose({ file_index: f.file_index, torrent_id: torrentId })}
                  className="hover:bg-card dark:hover:bg-card-dark flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                  <span className="text-muted font-mono">{formatSize(f.size_bytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted inline-flex items-center gap-1 text-sm hover:underline"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden /> Назад
    </button>
  );
}
