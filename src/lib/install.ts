import { useEffect, useState } from 'react';

/**
 * Install plumbing for the PWA.
 *
 * The listener is registered at module scope, not inside a component, and this
 * module is imported from main.tsx before React renders. Chrome fires
 * `beforeinstallprompt` as soon as its criteria are met, which is routinely
 * *before* a component effect has run — and the event is only offered once, so
 * a listener attached later never sees it and the app can never offer install.
 * Capturing it here and replaying it to subscribers removes that race.
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredEvent: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((fn) => fn());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress Chrome's mini-infobar so install can be offered in context.
    event.preventDefault();
    deferredEvent = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredEvent = null;
    notify();
  });
}

/** Safari on iOS/iPadOS. Chrome and Firefox on iOS cannot install at all. */
export const isIosSafari = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS =
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports as a Mac; the touch check separates it from a desktop.
    (/macintosh/i.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  return iOS && !/crios|fxios|edgios|opios/i.test(ua);
};

/** Any iOS browser that is not Safari — none of them can install a PWA. */
export const isIosNonSafari = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && /crios|fxios|edgios|opios/i.test(navigator.userAgent);
};

export const isStandalone = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    // iOS Safari does not implement display-mode.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true);

export interface InstallState {
  /** Chrome handed us a prompt we can fire. */
  canInstall: boolean;
  /** Already running as an installed app. */
  isInstalled: boolean;
  /** Needs the manual Share → Add to Home Screen route. */
  needsIosInstructions: boolean;
  /** On iOS but in a browser that cannot install at all. */
  isIosUnsupportedBrowser: boolean;
  /** Fires the native prompt. Resolves to the user's choice. */
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export const useInstall = (): InstallState => {
  const [, forceRender] = useState(0);

  useEffect(() => {
    const listener = () => forceRender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const standalone = isStandalone();

  const promptInstall = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredEvent) return 'unavailable';
    await deferredEvent.prompt();
    const { outcome } = await deferredEvent.userChoice;
    // The event is single-use; Chrome fires a fresh one if it still qualifies.
    deferredEvent = null;
    notify();
    return outcome;
  };

  return {
    canInstall: Boolean(deferredEvent) && !standalone && !installed,
    isInstalled: standalone || installed,
    needsIosInstructions: isIosSafari() && !standalone,
    isIosUnsupportedBrowser: isIosNonSafari() && !standalone,
    promptInstall,
  };
};
