import type {
  AudioCapabilities,
  AudioEngine,
  AudioEvent,
  AudioPosition,
  AudioSource,
  LoadOptions,
  NowPlaying,
} from '@/lib/player/audio/types';

/** Управляемый фейк `AudioEngine` для тестов контроллера: позиция, буфер и события задаются из теста. */
export class FakeAudioEngine implements AudioEngine {
  capabilities: AudioCapabilities = { backgroundSafe: false, gapless: false, headers: false, nativeNowPlaying: false };
  loads: { src: AudioSource; opts: LoadOptions }[] = [];
  nowPlaying: NowPlaying | null = null;
  preloaded: AudioSource | null = null;
  preloads: (AudioSource | null)[] = [];
  seeks: number[] = [];
  volume = -1;
  paused = true;
  loaded = false;
  unloads = 0;
  playCalls = 0;
  /** Следующий `play()` отклоняется этой ошибкой. */
  playError: Error | null = null;
  position: AudioPosition = { buffered: [], current: 0, duration: 0 };
  private handlers = new Set<(e: AudioEvent) => void>();

  get lastLoad() {
    return this.loads.at(-1);
  }

  load(src: AudioSource, opts: LoadOptions) {
    this.loads.push({ opts, src });
    this.loaded = true;
    this.paused = !opts.autoplay;
    this.position = { ...this.position, buffered: [], current: opts.positionOffset ?? opts.startAt };
  }
  unload() {
    this.unloads++;
    this.loaded = false;
    this.paused = true;
  }
  async play() {
    this.playCalls++;
    if (this.playError) throw this.playError;
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  seek(seconds: number) {
    this.seeks.push(seconds);
    this.position = { ...this.position, current: seconds };
  }
  setVolume(v: number) {
    this.volume = v;
  }
  preloadNext(src: AudioSource | null) {
    this.preloaded = src;
    this.preloads.push(src);
  }
  setNowPlaying(meta: NowPlaying | null) {
    this.nowPlaying = meta;
  }
  getPosition() {
    return this.position;
  }
  on(handler: (e: AudioEvent) => void) {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  }
  dispose() {
    this.handlers.clear();
  }

  /** Событие движка (как будто его прислал `<audio>` или нативный плеер). */
  emit(e: AudioEvent) {
    this.handlers.forEach(h => h(e));
  }
  /** Задаёт позицию и длительность трека. */
  setPosition(current: number, duration = this.position.duration, buffered: [number, number][] = []) {
    this.position = { buffered, current, duration };
  }
}
