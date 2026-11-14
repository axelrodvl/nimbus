import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getAudioInfo, type AudioInfoDto } from '@/lib/api/tracks';

/**
 * Параметры исходного аудио трека для строки качества. Пока грузится ответ для нового трека, остаётся предыдущий
 * (`stale: true`) — строка плавно гаснет, а не пропадает. `id === undefined` — запрос не делается.
 */
export function useAudioInfo(id: number | undefined): { info: AudioInfoDto | undefined; stale: boolean } {
  const q = useQuery({
    enabled: id !== undefined,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => getAudioInfo(id as number, signal),
    queryKey: ['audio-info', id],
    staleTime: 5 * 60_000,
  });
  return { info: q.data, stale: q.isPlaceholderData };
}
