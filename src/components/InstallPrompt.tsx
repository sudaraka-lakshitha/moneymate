import React, { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'moneymate.installDismissed';

const isIos = (): boolean =>
  typeof navigator !== 'undefined' &&
  /iphone|ipad|ipod/i.test(navigator.userAgent) &&
  !/crios|fxios/i.test(navigator.userAgent);

const isStandalone = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari does not implement display-mode.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true);

/**
 * Drives a real install rather than a home-screen bookmark.
 *
 * On Android/Chrome, calling prompt() on the beforeinstallprompt event installs
 * a WebAPK — which is what makes the app show up in the app drawer, the app
 * settings list and the share sheet. "Add to Home screen" from the browser menu
 * only creates a shortcut. iOS has no equivalent API and no app drawer, so
 * there we just show the Share-sheet instructions.
 */
export const InstallPrompt: React.FC = () => {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (isStandalone()) return;

    const onBeforeInstall = (event: Event) => {
      // Suppress Chrome's mini-infobar so we can offer install in context.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };

    const onInstalled = () => {
      setDeferred(null);
      setShowIosHelp(false);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    // iOS never fires beforeinstallprompt, so offer the manual route.
    if (isIos()) setShowIosHelp(true);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore
    }
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    if (outcome === 'dismissed') close();
  };

  if (dismissed || isStandalone()) return null;
  if (!deferred && !showIosHelp) return null;

  return (
    <div style={{ padding: 'var(--sp-3) var(--sp-4) 0' }}>
      <div className="card row" style={{ gap: 'var(--sp-3)' }}>
        <span
          className="icon-tile"
          style={{
            width: 38,
            height: 38,
            background: 'var(--primary-container)',
            color: 'var(--primary)',
          }}
        >
          <Download size={18} />
        </span>

        <span className="grow" style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem' }}>
            Install MoneyMate
          </span>
          <span className="hint">
            {deferred
              ? 'Adds it to your app drawer and runs it full screen.'
              : 'Tap Share, then “Add to Home Screen”.'}
          </span>
        </span>

        {deferred ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={install}>
            Install
          </button>
        ) : (
          <Share size={17} color="var(--primary)" style={{ flexShrink: 0 }} />
        )}

        <button
          type="button"
          className="btn-icon"
          style={{ width: 28, height: 28 }}
          onClick={close}
          aria-label="Dismiss install prompt"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
};
