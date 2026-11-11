'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { loadTorrentFiles } from '@/app/actions/sources';
import { KIND_LABEL, META_LABEL, SOURCE_LABEL, formatSize } from '@/features/sources/format';
import type { Schemas } from '@/lib/api/client';

type Props = {
  torrents: Schemas['AlbumTorrentDto'][];
  /** Названия треков альбома по id (для пометок в списке файлов). */
  trackTitles: Record<number, string>;
};

export function TorrentTable({ torrents, trackTitles }: Props) {
  if (torrents.length === 0) {
    return (
      <p className="text-muted text-sm" data-testid="no-torrents">
        Раздачи пока не найдены. Повторите поиск или добавьте magnet вручную.
      </p>
    );
  }
  return (
    <ul data-testid="torrent-list" className="flex flex-col gap-2">
      {torrents.map(t => (
        <TorrentItem key={t.torrent.id} item={t} trackTitles={trackTitles} />
      ))}
    </ul>
  );
}

function TorrentItem({ item, trackTitles }: { item: Schemas['AlbumTorrentDto']; trackTitles: Record<number, string> }) {
  const { torrent: t } = item;
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<Schemas['TorrentFileDto'][] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && files === null) {
      const r = await loadTorrentFiles(t.id);
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
        <span className="bg-card dark:bg-card-dark shrink-0 rounded px-2 py-0.5 text-xs font-medium" title="Источник">
          {SOURCE_LABEL[t.source] ?? t.source}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
        <span className="text-muted hidden text-xs sm:inline">{KIND_LABEL[t.kind] ?? t.kind}</span>
        <span className="text-muted hidden font-mono text-xs sm:inline">{formatSize(t.size_bytes)}</span>
        <span className="text-muted font-mono text-xs" title="Сиды / личи">
          {t.seeders ?? '?'}/{t.leechers ?? '?'}
        </span>
        <span className="text-muted hidden text-xs md:inline">{META_LABEL[t.meta_status] ?? t.meta_status}</span>
        <span className="text-xs whitespace-nowrap" title="Найдено треков альбома">
          {item.matched_tracks} тр.
        </span>
      </button>
      {open ? (
        <div className="border-divider dark:border-divider-dark border-t px-3 py-2">
          {error ? <p className="text-danger text-xs">{error}</p> : null}
          {files === null && !error ? <p className="text-muted text-xs">Загрузка…</p> : null}
          {files?.length === 0 ? (
            <p className="text-muted text-xs">Файлы ещё неизвестны (метаданные не получены).</p>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {files?.map(f => (
              <li key={f.file_index} data-testid="torrent-file" className="flex items-center gap-3 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                <span className="text-muted font-mono">{formatSize(f.size_bytes)}</span>
                {f.matched_track_id != null ? (
                  <span className="text-accent truncate">
                    {trackTitles[f.matched_track_id] ?? `трек #${f.matched_track_id}`}
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
