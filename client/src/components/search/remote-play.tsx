import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { Equalizer } from '@/components/ui/equalizer';
import { Spinner } from '@/components/ui/spinner';
import { useT } from '@/lib/i18n/provider';
import { currentTrack } from '@/lib/player/engine';
import { usePlayerState } from '@/lib/player/hooks';
import { addToHistory } from '@/lib/search/history';
import { playRemoteApp, usePlayPending, type PlayRemoteRequest } from '@/lib/search/play-remote';
import { useTrackView } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

type Props = {
  request: PlayRemoteRequest;
  /** Запрос поиска — попадёт в историю. */
  query?: string;
  /** Миниатюра слева (обложка или номер); поверх неё — состояние: ждём источник / играет / «играть» при наведении. */
  leading: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * Играет ли сейчас эта запись — в библиотеке трек или его просто слушают: по текущему треку плеера и его MBID записи
 * (у трека из библиотеки — ещё и точный `trackId`).
 */
function useIsRecordingPlaying(request: PlayRemoteRequest): boolean {
  const id = usePlayerState(s => (s.isPlaying ? (currentTrack(s)?.id ?? null) : null));
  const view = useTrackView(id ?? -1);
  if (!view) return false;
  return request.trackId !== undefined ? view.id === request.trackId : view.mbid_recording === request.mbid;
}

/**
 * Строка трека из MusicBrainz — целиком кнопка «играть»: трек играет, не добавляясь в библиотеку; если источника
 * ещё нет — заигрывает, как только он найдётся (до этого поверх миниатюры крутится спиннер). Доступное имя — видимый
 * текст строки.
 */
export function RemotePlayRow({ request, query, leading, children, className }: Props) {
  const t = useT();
  const pending = usePlayPending(request);
  const playing = useIsRecordingPlaying(request);
  return (
    <button
      aria-busy={pending || undefined}
      className={cn(
        'group focus-visible:ring-accent/40 flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:outline-none',
        className,
      )}
      data-pending={pending || undefined}
      data-playing={playing || undefined}
      data-testid="remote-play"
      onClick={() => {
        if (query) addToHistory(query);
        playRemoteApp().playRemote(request, t);
      }}
      title={pending ? t('play.waitingShort') : t('row.play', { title: request.title })}
      type="button"
    >
      <span className="relative shrink-0">
        {leading}
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 flex items-center justify-center rounded-md bg-black/50 text-white transition-opacity',
            pending || playing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
        >
          {pending ? (
            <Spinner className="size-4" />
          ) : playing ? (
            <Equalizer size="sm" />
          ) : (
            <Play className="size-4" fill="currentColor" />
          )}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">{children}</span>
      {pending ? <span className="sr-only">{t('play.waitingShort')}</span> : null}
    </button>
  );
}
