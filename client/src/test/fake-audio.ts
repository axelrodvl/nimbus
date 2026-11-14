/** Фейковый `HTMLAudioElement`: хранит `src`, считает `play()`, события шлёт тест (`fire`). */
export class FakeAudio extends EventTarget {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = Number.NaN;
  volume = 1;
  readyState = 0;
  ranges: [number, number][] = [];
  playCalls = 0;
  loadCalls = 0;
  /** Следующий `play()` отклоняется этой ошибкой. */
  playError: DOMException | null = null;
  private attrs = new Map<string, string>();

  get buffered() {
    const r = this.ranges;
    return { end: (i: number) => r[i][1], length: r.length, start: (i: number) => r[i][0] };
  }
  set src(v: string) {
    this.attrs.set('src', v);
  }
  get src() {
    return this.attrs.get('src') ?? '';
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  play(): Promise<void> {
    this.playCalls++;
    if (this.playError) return Promise.reject(this.playError);
    this.paused = false;
    this.fire('play');
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire('pause');
  }
  load() {
    this.loadCalls++;
  }
  fire(name: string) {
    this.dispatchEvent(new Event(name));
  }
  asElement(): HTMLAudioElement {
    return this as unknown as HTMLAudioElement;
  }
}

/** Фейковый `MediaSession`: запоминает обработчики действий и вызовы `setPositionState`. */
export class FakeMediaSession {
  metadata: unknown = null;
  playbackState: MediaSessionPlaybackState = 'none';
  handlers = new Map<string, MediaSessionActionHandler | null>();
  positions: MediaPositionState[] = [];
  /** Действия, которые «не поддерживаются» этим браузером. */
  unsupported = new Set<string>();
  setActionHandler(name: string, handler: MediaSessionActionHandler | null) {
    if (this.unsupported.has(name)) throw new TypeError('unsupported');
    this.handlers.set(name, handler);
  }
  setPositionState(state?: MediaPositionState) {
    if (state) this.positions.push(state);
  }
  /** Вызывает обработчик действия, как это сделала бы система. */
  trigger(name: string, details: Partial<MediaSessionActionDetails> = {}) {
    this.handlers.get(name)?.({ action: name as MediaSessionAction, ...details });
  }
  asSession(): MediaSession {
    return this as unknown as MediaSession;
  }
}

/** Подменяет глобальный `MediaMetadata` (в happy-dom его нет): конструктор сохраняет поля. */
export class FakeMediaMetadata {
  title = '';
  artist = '';
  album = '';
  artwork: unknown[] = [];
  constructor(init: MediaMetadataInit) {
    Object.assign(this, init);
  }
}
