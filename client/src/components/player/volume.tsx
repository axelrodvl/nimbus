import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { useT } from '@/lib/i18n/provider';
import { usePlayerActions, usePlayerState } from '@/lib/player/hooks';
import { SeekBar } from './seek-bar';

/** Кнопка «без звука» и полоса громкости (настольная панель). */
export function Volume() {
  const t = useT();
  const player = usePlayerActions();
  const effective = usePlayerState(s => (s.muted ? 0 : s.volume));
  const Icon = effective === 0 ? VolumeX : effective < 50 ? Volume1 : Volume2;
  return (
    <div className="flex items-center gap-2">
      <button
        aria-label={effective === 0 ? t('player.unmute') : t('player.mute')}
        className="text-muted focus-visible:ring-accent/40 rounded-full transition-colors hover:text-black focus-visible:ring-2 focus-visible:outline-none dark:hover:text-white"
        onClick={player.toggleMute}
        type="button"
      >
        <Icon className="size-3.5" />
      </button>
      <SeekBar className="w-20" label={t('player.volume')} max={100} onChange={player.setVolume} value={effective} />
    </div>
  );
}
