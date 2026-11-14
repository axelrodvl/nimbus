import { formatAudioInfo, type AudioInfo } from '@/lib/library/audio-info';
import { cn } from '@/lib/utils';

/** Строка качества звука. Занимает фиксированную высоту, чтобы вёрстка не прыгала; данные подаёт плеер (шаг 41). */
export function AudioQuality({ info, className }: { info: AudioInfo | null | undefined; className?: string }) {
  return (
    <div
      className={cn('flex h-4 items-center justify-center text-[11px] tabular-nums', className)}
      data-testid="audio-quality"
    >
      <span
        className={cn(
          'truncate transition-opacity duration-300 ease-out motion-reduce:transition-none',
          info ? 'opacity-100' : 'opacity-0',
        )}
      >
        {info ? formatAudioInfo(info) : ''}
      </span>
    </div>
  );
}
