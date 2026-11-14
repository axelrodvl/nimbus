import type { Schemas } from '@/lib/api/client';

export type AudioInfo = Schemas['AudioInfo'];

const kHz = (hz: number) => `${Number((hz / 1000).toFixed(1))} kHz`;

/** «FLAC · 24-bit · 96 kHz · stereo»; перекодированный поток помечается `→ FLAC`. */
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
