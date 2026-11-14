import { useT } from '@/lib/i18n/provider';
import { usePlayerActions, useProgress } from '@/lib/player/hooks';
import { formatDuration } from '@/lib/utils';
import { SeekBar } from './seek-bar';

type Props = {
  disabled?: boolean;
  className?: string;
  /** `bar` — «время — полоса — время» в одну строку; `full` — полоса, под ней времена по краям. */
  layout?: 'bar' | 'full';
  testIds?: { elapsed?: string; seek?: string };
};

/** Полоса прогресса со временами. Позиция читается из движка (`useProgress`), не из общего store. */
export function ProgressRow({ disabled, className, layout = 'bar', testIds }: Props) {
  const t = useT();
  const player = usePlayerActions();
  const { current, duration, buffered } = useProgress();
  const elapsed = formatDuration(Math.floor(current));
  const total = formatDuration(Math.floor(duration));
  const bar = (
    <SeekBar
      buffered={buffered}
      disabled={disabled}
      label={t('player.seek')}
      max={duration}
      onChange={player.seekTo}
      size={layout === 'full' ? 'full' : 'bar'}
      testId={testIds?.seek}
      value={current}
    />
  );
  if (layout === 'full') {
    return (
      <div className={className}>
        {bar}
        <div className="mt-1 flex justify-between text-xs text-black/70 tabular-nums dark:text-white/75">
          <span data-testid={testIds?.elapsed}>{elapsed}</span>
          <span>{total}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`flex w-full items-center gap-2 ${className ?? ''}`}>
      <span className="text-muted w-8 text-right text-[10px] tabular-nums" data-testid={testIds?.elapsed}>
        {elapsed}
      </span>
      {bar}
      <span className="text-muted w-8 text-[10px] tabular-nums">{total}</span>
    </div>
  );
}
