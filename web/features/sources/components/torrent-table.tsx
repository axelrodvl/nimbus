'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { loadTorrentFiles } from '@/app/actions/sources';
import { kindLabel, metaLabel, sourceLabel, formatSize } from '@/features/sources/format';
import type { Schemas } from '@/lib/api/client';
import { useT } from '@/providers/i18n-provider';

type Props = {
  torrents: Schemas['AlbumTorrentDto'][];
  /** Названия треков альбома по id (для пометок в списке файлов). */
  trackTitles: Record<number, string>;
};

export function TorrentTable({ torrents, trackTitles }: Props) {
  const t = useT();
  if (torrents.length === 0) {
    return (
      <p className="text-muted text-sm" data-testid="no-torrents">
        {t('sources.none')}
      </p>
    );
  }
  return (
    <ul data-testid="torrent-list" className="flex flex-col gap-2">
      {torrents.map(item => (
        <TorrentItem key={item.torrent.id} item={item} trackTitles={trackTitles} />
      ))}
    </ul>
  );
}

function TorrentItem({ item, trackTitles }: { item: Schemas['AlbumTorrentDto']; trackTitles: Record<number, string> }) {
  const t = useT();
  const { torrent: tor } = item;
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<Schemas['TorrentFileDto'][] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && files === null) {
      const r = await loadTorrentFiles(tor.id);
      if (r.ok) setFiles(r.files);
      else setError(r.message);
    }
  }

  return (
    <li data-testid="torrent-item" className="border-divider dark:border-divider-dark rounded-lg border">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="hover:bg-card/60 dark:hover:bg-card-dark/60 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
        )}
        <span className="bg-card dark:bg-card-dark shrink-0 rounded px-2 py-0.5 text-xs font-medium" title={t('sources.sourceTitle')}>
          {sourceLabel(tor.source, t)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{tor.title}</span>
        <span className="text-muted hidden text-xs sm:inline">{kindLabel(tor.kind, t)}</span>
        <span className="text-muted hidden font-mono text-xs sm:inline">{formatSize(tor.size_bytes, t)}</span>
        <span className="text-muted font-mono text-xs" title={t('sources.seedsLeeches')}>
          {tor.seeders ?? '?'}/{tor.leechers ?? '?'}
        </span>
        <span className="text-muted hidden text-xs md:inline">{metaLabel(tor.meta_status, t)}</span>
        <span className="text-xs whitespace-nowrap" title={t('sources.matchedTracks')}>
          {t('sources.matchedShort', { count: item.matched_tracks })}
        </span>
      </button>
      {open ? (
        <div className="border-divider dark:border-divider-dark border-t px-3 py-2">
          {error ? <p className="text-danger text-xs">{error}</p> : null}
          {files === null && !error ? <p className="text-muted text-xs">{t('common.loading')}</p> : null}
          {files?.length === 0 ? (
            <p className="text-muted text-xs">{t('sources.filesUnknown')}</p>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {files?.map(f => (
              <li key={f.file_index} data-testid="torrent-file" className="flex items-center gap-3 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                <span className="text-muted font-mono">{formatSize(f.size_bytes, t)}</span>
                {f.matched_track_id != null ? (
                  <span className="text-accent truncate">
                    {trackTitles[f.matched_track_id] ?? t('sources.trackFallback', { id: f.matched_track_id })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
