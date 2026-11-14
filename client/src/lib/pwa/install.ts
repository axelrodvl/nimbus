// Установка приложения: `beforeinstallprompt` (Chromium) и подсказка для iOS Safari.
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const store = createStore<{ event: InstallPromptEvent | null }>(() => ({ event: null }));

/** Слушает `beforeinstallprompt` и `appinstalled`; вызывается один раз при старте. */
export function listenForInstall(target: Pick<Window, 'addEventListener'> = globalThis): void {
  target.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    store.setState({ event: e as InstallPromptEvent });
  });
  target.addEventListener('appinstalled', () => store.setState({ event: null }));
}

/** Показать системный диалог установки. Событие одноразовое. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = store.getState().event;
  if (!event) return 'unavailable';
  store.setState({ event: null });
  await event.prompt();
  return (await event.userChoice).outcome;
}

/** Браузер предлагает установку (событие получено). */
export const useCanInstall = (): boolean => useStore(store, s => s.event !== null);

/** iOS Safari вне standalone-режима: установка — только через «Поделиться → На экран Домой». */
export function needsIosInstallHint(
  nav: { userAgent: string; maxTouchPoints?: number; standalone?: boolean } = globalThis.navigator,
  standaloneMedia: boolean = globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false,
): boolean {
  const ua = nav.userAgent;
  // iPadOS 13+ выдаёт себя за Mac, но имеет тачскрин.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return ios && safari && !standaloneMedia && nav.standalone !== true;
}

/** Только для тестов. */
export function resetInstallForTests(): void {
  store.setState({ event: null });
}
