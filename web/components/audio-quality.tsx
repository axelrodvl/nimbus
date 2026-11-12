'use client';

import { useEffect, useState } from 'react';
import { api, type Schemas } from '@/lib/api/client';
import { cn } from '@/lib/utils';

type AudioInfo = Schemas['AudioInfo'];

function kHz(hz: number): string {
  return `${Number((hz / 1000).toFixed(1))} kHz`;
}

export function formatAudioInfo(i: AudioInfo): string {
  const codec = (i.codec ?? i.ext).toUpperCase().replace(/^PCM_.*/, 'PCM');
  const parts = [codec];
  if (i.bit_depth) parts.push(`${i.bit_depth}-bit`);
  if (i.sample_rate) parts.push(kHz(i.sample_rate));
  if (i.channels) parts.push(i.channels);
  if (i.bitrate_kbps) parts.push(`${i.bitrate_kbps} kbps`);
  const text = parts.join(' · ');
  return i.transcoded ? `${text} → FLAC` : text;
}

// Строка качества воспроизведения. Занимает фиксированную высоту, чтобы вёрстка не прыгала.
export function AudioQuality({ trackId, className }: { trackId: number | undefined; className?: string }) {
  const [state, setState] = useState<{ id: number; text: string } | null>(null);

  useEffect(() => {
    if (trackId === undefined) return;
    let cancelled = false;
    api
      .GET('/api/tracks/{id}/audio-info', { params: { path: { id: trackId } } })
      .then(({ data }) => {
        if (!cancelled && data) setState({ id: trackId, text: formatAudioInfo(data) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  const text = state && state.id === trackId ? state.text : '';
  return (
    <div
      data-testid="audio-quality"
      className={cn('flex h-4 items-center justify-center text-[11px] tabular-nums', className)}
    >
      <span className="truncate">{text}</span>
    </div>
  );
}
