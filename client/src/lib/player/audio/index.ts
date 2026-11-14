import type { AudioEngine } from './types';
import { sharedWebAudioEngine } from './web-engine';

export type * from './types';

/**
 * Единственная точка выбора реализации `AudioEngine`. Сейчас на всех платформах — `<audio>` + Media Session
 * (PWA и настольная оболочка). Нативные оболочки (шаг 53) добавят здесь ветку по `platform()` с нативным плеером.
 */
export function createAudioEngine(): AudioEngine {
  return sharedWebAudioEngine();
}
