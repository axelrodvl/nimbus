import { useEffect, useState } from 'react';
import { usePlayerState } from '@/lib/player/hooks';
import { player } from '@/lib/player';
import { installShortcuts } from '@/lib/player/shortcuts';
import { FullPlayer } from './full-player';
import { MiniPlayer } from './mini-player';
import { PlayerBar } from './player-bar';
import { QueuePanel } from './queue-panel';

/** Плеер приложения: настольная панель, мобильный мини-плеер, полноэкранный режим, очередь, горячие клавиши. */
export function Player() {
  const hasTrack = usePlayerState(s => s.index >= 0 && s.queue.length > 0);
  const [queueOpen, setQueueOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  useEffect(() => installShortcuts(player()), []);
  const closeFull = () => setFullOpen(false);
  return (
    <>
      <QueuePanel onClose={() => setQueueOpen(false)} open={queueOpen} />
      <FullPlayer onClose={closeFull} onOpenQueue={() => setQueueOpen(true)} open={fullOpen && hasTrack} />
      <MiniPlayer onOpenFull={() => setFullOpen(true)} onToggleQueue={() => setQueueOpen(o => !o)} />
      <PlayerBar
        onOpenFull={() => hasTrack && setFullOpen(true)}
        onToggleQueue={() => setQueueOpen(o => !o)}
        queueOpen={queueOpen}
      />
    </>
  );
}
