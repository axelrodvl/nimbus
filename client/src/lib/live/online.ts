import { appData } from '@/lib/app-data';
import { networkStatus } from './hooks';

/** Можно ли сейчас рассчитывать на сервер (без React): сеть браузера есть и сокет не закрыт. */
export function isOnlineNow(): boolean {
  return networkStatus(globalThis.navigator?.onLine !== false, appData().socket.state.getState().state) === 'online';
}
