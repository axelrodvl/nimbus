import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { AddMagnetForm } from '@/features/sources/components/add-magnet-form';
import { RetryAlbumButton } from '@/features/sources/components/retry-album-button';
import { TorrentTable } from '@/features/sources/components/torrent-table';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { getAlbum } from '@/lib/data/library';

export async function SourcesPage({ id }: { id: string }) {
  const { album, tracks } = await getAlbum(id);
  await connection();
  const res = await api.GET('/api/albums/{id}/torrents', { params: { path: { id: album.id } } });
  if (res.response.status === 404) notFound();
  const torrents = unwrap(res);
  const trackTitles = Object.fromEntries(tracks.map(t => [t.id, t.title]));
  return (
    <>
      <Link
        href={`/album/${album.id}`}
        className="text-muted mb-4 inline-flex items-center gap-1 text-sm hover:underline"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> {album.title}
      </Link>
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Источники</h1>
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <RetryAlbumButton albumId={album.id} />
        </div>
        <AddMagnetForm albumId={album.id} />
      </div>
      <TorrentTable torrents={torrents} trackTitles={trackTitles} />
    </>
  );
}
