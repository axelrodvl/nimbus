import { toast } from 'sonner';
import { enMessages, type TFn } from '@/lib/i18n/messages';
import { i18n } from '@/lib/i18n/store';
import { translate } from '@/lib/i18n/translate';
import { playerErrorText, type PlayerError } from './engine';
import type { PlayerTrack } from './track';

const t: TFn = (key, params) => {
  const { locale, messages } = i18n.getState();
  return translate(messages, locale, key, params, enMessages);
};

/** Toast «Название: причина» на языке интерфейса. */
export function notifyPlayerError(track: PlayerTrack, error: PlayerError): void {
  toast.error(`${track.title}: ${playerErrorText(t, error.code)}`);
}
