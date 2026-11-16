import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTrackOffline } from '@/lib/offline/hooks';
import { useT } from '@/lib/i18n/provider';
import { describeDownload, playerErrorText } from '@/lib/player/engine';
import { usePlayerActions, usePlayerState } from '@/lib/player/hooks';
import { useLive, useTrackView } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';
import { isConnecting } from './transport';

/** Подключение короче этого не показываем: на быстрых источниках подпись только моргала бы. */
const CONNECTING_DELAY_MS = 800;

/** `true`, когда `active` держится дольше `delay` мс подряд. */
function useDelayed(active: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setShown(true), delay);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [active, delay]);
  return active && shown;
}

/**
 * Состояние под полосой прогресса: подключение к раздаче, загрузка из торрента (`stream.progress` из live-store),
 * ошибка. Для скачанного (`ready`) трека прогресса загрузки нет.
 */
export function DownloadInfo({ className }: { className?: string }) {
  const t = useT();
  const player = usePlayerActions();
  const trackId = usePlayerState(s => s.queue[s.index]?.id ?? -1);
  const status = usePlayerState(s => s.status);
  const error = usePlayerState(s => s.error);
  const live = useTrackView(trackId);
  const progress = useLive(s => s.streamProgress.get(trackId));
  const onDevice = useTrackOffline(trackId).kind === 'done';
  // Скачанный на сервер или на устройство трек раздачи не ждёт — подпись не нужна вовсе.
  const local = live?.status === 'ready' || onDevice;
  const connectingShown = useDelayed(isConnecting(status) && !local, CONNECTING_DELAY_MS);
  if (trackId < 0) return null;
  // Для скачанного трека и после отмены прогресса загрузки нет.
  const download = live?.status === 'ready' || status === 'idle' ? undefined : progress;
  const connecting = isConnecting(status);
  let text: string | null = null;
  if (status === 'error' && error) text = playerErrorText(t, error.code);
  else if (connectingShown && (!download || download.bytes_done === 0)) {
    const peers = download?.peers ?? 0;
    text = peers > 0 ? t('player.connectingPeers', { peers }) : t('player.connecting');
  } else if (download && download.bytes_done < download.bytes_total) text = describeDownload(download, t);
  if (!text) return null;
  return (
    <div
      className={cn(
        'text-muted flex items-center justify-center gap-2 text-[11px]',
        status === 'error' && 'text-danger-fg',
        className,
      )}
      data-testid="player-status"
    >
      <span>{text}</span>
      {connecting ? (
        <button
          aria-label={t('player.cancel')}
          className="inline-flex items-center hover:text-black dark:hover:text-white"
          onClick={player.cancel}
          type="button"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
