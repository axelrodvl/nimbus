// Граница между контроллером плеера и тем, что реально играет звук. В PWA её реализует `<audio>` + Media Session
// (`web-engine.ts`), в нативных оболочках (шаг 53) — нативный плеер. Контракт общий: менять только вместе с шагом 53.
// Сюда не должны попадать особенности `<audio>` (`readyState`, `TimeRanges`, `canplaythrough`).

export type AudioSource = {
  url: string;
  mime?: string;
  /** Заголовки запроса (Bearer в нативных оболочках). В PWA авторизует cookie — `web-engine` их игнорирует. */
  headers?: Record<string, string>;
  /** `transcode` — поток без Range: позицию внутри трека задаёт `?t=` в адресе, а не перемотка. */
  mode: 'direct' | 'transcode';
};

export type NowPlaying = {
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  /** Секунды; 0 — неизвестна. */
  durationS: number;
};

export type RemoteAction = 'play' | 'pause' | 'next' | 'previous' | 'seekto' | 'seekforward' | 'seekbackward';

export type AudioEvent =
  | { type: 'loading' }
  | { type: 'playing' }
  /** `interrupted` — пауза не от пользователя (звонок, Siri, отключение наушников, другое приложение). */
  | { type: 'paused'; interrupted?: boolean }
  | { type: 'waiting' }
  | { type: 'ended' }
  | { type: 'error'; code: string }
  /** Движок сам перешёл к `preloadNext` (нативный gapless). Веб-реализация этого события не шлёт. */
  | { type: 'advanced' }
  /** Команда экрана блокировки, гарнитуры или медиаклавиш; `seekTo`/`offset` — секунды. */
  | { type: 'remote'; action: RemoteAction; seekTo?: number; offset?: number };

export type AudioPosition = {
  /** Секунды от начала трека (для `transcode` — с учётом `positionOffset`). */
  current: number;
  duration: number;
  buffered: [number, number][];
};

export type AudioCapabilities = {
  gapless: boolean;
  nativeNowPlaying: boolean;
  backgroundSafe: boolean;
  headers: boolean;
};

export type LoadOptions = {
  /** Позиция начала (секунды). Для `transcode` игнорируется: начало задано адресом (`positionOffset`). */
  startAt: number;
  autoplay: boolean;
  /** Для `transcode`: с какой секунды трека начинается поток. */
  positionOffset?: number;
};

export interface AudioEngine {
  readonly capabilities: AudioCapabilities;
  /** Синхронно: на iOS `play()` обязан вызываться в цепочке жеста пользователя. */
  load(src: AudioSource, opts: LoadOptions): void;
  /**
   * Необязательно. Вызывается синхронно в обработчике жеста, когда трек начнётся позже (ждём источника): веб-движок
   * «разблокирует» аудиоэлемент, иначе iOS отклонит отложенный `play()`. Нативные оболочки не нуждаются.
   */
  prime?(): void;
  /** Сбросить источник (отмена загрузки, пустая очередь). События уже сброшенного источника отбрасываются. */
  unload(): void;
  play(): Promise<void>;
  pause(): void;
  /** Перемотка внутри уже загруженного `direct`-трека (для `transcode` контроллер загружает поток заново). */
  seek(seconds: number): void;
  /** 0–1. */
  setVolume(v: number): void;
  /** Следующий трек: web — ничего не делает (предзагрузку делает сервер), native — очередь плеера (gapless). */
  preloadNext(src: AudioSource | null): void;
  setNowPlaying(meta: NowPlaying | null): void;
  getPosition(): AudioPosition;
  /** Фактическое состояние звука (а не намерение): нужно, чтобы сверить плеер после возврата из фона. */
  isPlaying(): boolean;
  on(handler: (e: AudioEvent) => void): () => void;
  dispose(): void;
}
