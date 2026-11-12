'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { loadDownloads, setDownloadPaused } from '@/app/actions/downloads';
import { Button } from '@/components/ui/button';
import type { Download, DownloadState, Downloads } from '@/features/downloads/types';
import { formatSize } from '@/features/sources/format';
import type { MessageKey } from '@/lib/i18n/messages';
import { useT, type TFn } from '@/providers/i18n-provider';

const POLL_MS = 2000;

const STATE_KEYS: Record<DownloadState, MessageKey> = {
  downloading: 'downloads.state.downloading',
  error: 'downloads.state.error',
  initializing: 'downloads.state.initializing',
  paused: 'downloads.state.paused',
  seeding: 'downloads.state.seeding',
};

const STATE_COLORS: Record<DownloadState, string> = {
  downloading: 'text-accent',
  error: 'text-danger',
  initializing: 'text-muted',
  paused: 'text-muted',
  seeding: 'text-success',
};

const speed = (bps: number, t: TFn) => `${formatSize(bps, t)}/${t('downloads.sec')}`;

function Row({ d, onToggle, busy }: { d: Download; onToggle: (d: Download) => void; busy: boolean }) {
  const t = useT();
  const pct = d.total_bytes > 0 ? Math.min(100, (d.progress_bytes / d.total_bytes) * 100) : 0;
  const paused = d.state === 'paused';
  return (
    <li data-testid="download-row" data-state={d.state} className="border-divider dark:border-divider-dark flex flex-col gap-2 border-b py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={d.name}>
            {d.name}
          </p>
          <p className={`text-xs ${STATE_COLORS[d.state]}`}>
            {t(STATE_KEYS[d.state])}
            {d.error ? `: ${d.error}` : ''}
          </p>
        </div>
        {d.state !== 'error' && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => onToggle(d)}>
            {paused ? t('downloads.resume') : t('downloads.pause')}
          </Button>
        )}
      </div>
      <div className="bg-card dark:bg-card-dark h-1.5 overflow-hidden rounded-full">
        <div className="bg-accent h-full" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-muted flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>
          {formatSize(d.progress_bytes, t)} / {formatSize(d.total_bytes, t)} ({pct.toFixed(0)}%)
        </span>
        <span>
          ↓ {speed(d.down_bps, t)} · ↑ {speed(d.up_bps, t)}
        </span>
        <span>{t('downloads.peers', { peers: d.peers, seeds: d.seeds })}</span>
        <span>{t('downloads.uploaded', { size: formatSize(d.uploaded_bytes, t) })}</span>
      </p>
    </li>
  );
}

// Менеджер загрузок: опрашивает бэкенд раз в 2 с, пауза/запуск применяются сразу.
export function DownloadsView() {
  const t = useT();
  const [data, setData] = useState<Downloads | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, start] = useTransition();

  const refresh = useCallback(async () => {
    const r = await loadDownloads();
    if (r.ok) setData(r.downloads);
    setFailed(!r.ok);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (alive && !document.hidden) await refresh();
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refresh]);

  const toggle = (d: Download) =>
    start(async () => {
      const r = await setDownloadPaused(d.info_hash, d.state !== 'paused');
      if (!r.ok) toast.error(r.message);
      await refresh();
    });

  if (!data) {
    return <p className="text-muted text-sm">{failed ? t('downloads.unavailable') : t('downloads.loading')}</p>;
  }
  return (
    <div data-testid="downloads" className="max-w-2xl">
      {failed && <p className="text-danger mb-2 text-xs">{t('downloads.unavailable')}</p>}
      <p className="text-muted mb-2 text-sm">
        {t('downloads.total', { count: data.torrents.length, down: speed(data.down_bps, t), up: speed(data.up_bps, t) })}
      </p>
      {data.torrents.length === 0 ? (
        <p className="text-muted py-6 text-sm">{t('downloads.empty')}</p>
      ) : (
        <ul>
          {data.torrents.map(d => (
            <Row key={d.info_hash} d={d} onToggle={toggle} busy={busy} />
          ))}
        </ul>
      )}
    </div>
  );
}
