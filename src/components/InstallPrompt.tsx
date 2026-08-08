import React, { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { useInstall } from '../lib/install';
import { Alert, Sheet } from './ui';

const DISMISS_KEY = 'moneymate.installDismissed';

/**
 * Drives a real install rather than a home-screen bookmark.
 *
 * On Android/Chrome, prompt() installs a WebAPK — which is what puts the app in
 * the app drawer, the app settings list and the share sheet. "Add to Home
 * screen" from the browser menu only makes a shortcut. iOS has no equivalent
 * API, so there the only route is Safari's own Share menu and all this banner
 * can do is explain where to find it.
 *
 * Dismissing hides the banner but never removes the ability to install — the
 * same actions live permanently in Settings, so a dismissal is not a dead end.
 */
export const InstallPrompt: React.FC = () => {
  const { canInstall, isInstalled, needsIosInstructions, promptInstall } = useInstall();
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Private mode — the banner simply returns next launch.
    }
  };

  const handleInstall = async () => {
    const outcome = await promptInstall();
    if (outcome === 'dismissed') close();
  };

  if (isInstalled || dismissed) return null;
  if (!canInstall && !needsIosInstructions) return null;

  return (
    <>
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
              {canInstall
                ? 'Adds it to your app drawer and runs it full screen.'
                : 'Add it to your Home Screen from Safari.'}
            </span>
          </span>

          {/* iOS previously rendered a bare Share icon here — it sat exactly
              where the Install button sits, so it read as a button but had no
              handler and did nothing when tapped. It is a real button now. */}
          {canInstall ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={handleInstall}>
              Install
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowIosHelp(true)}
            >
              <Share size={14} /> How
            </button>
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

      {showIosHelp && <IosInstallHelp onClose={() => setShowIosHelp(false)} />}
    </>
  );
};

/** Safari's Share button lives in the browser chrome, not in the page. */
export const IosInstallHelp: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <Sheet title="Add to Home Screen" onClose={onClose}>
    <div className="stack">
      <p className="text-muted" style={{ fontSize: '0.88rem' }}>
        iPhone and iPad can only install a web app from Safari's own menu — no website can trigger it,
        which is why there is no Install button here.
      </p>

      <ol className="stack-sm" style={{ paddingLeft: '1.1rem', fontSize: '0.9rem', lineHeight: 1.6 }}>
        <li>
          Tap the <strong>Share</strong> button in Safari — the square with an arrow pointing up. It is at
          the <strong>bottom</strong> of the screen on an iPhone, and at the <strong>top right</strong> on an
          iPad.
        </li>
        <li>
          Scroll down the list and tap <strong>Add to Home Screen</strong>.
        </li>
        <li>
          Tap <strong>Add</strong>. MoneyMate then opens full screen, with offline support.
        </li>
      </ol>

      {/* The Alert component, not a raw .alert div: .alert is display:flex with
          a gap, so an element child like <strong> becomes its own flex item and
          gets torn out of the sentence. Alert wraps children in a single span. */}
      <Alert variant="info">
        Using Chrome or Firefox on iPhone? Neither can add to the Home Screen — open
        moneymate-olive.vercel.app in <strong>Safari</strong> first.
      </Alert>

      <button type="button" className="btn btn-primary btn-block btn-lg" onClick={onClose}>
        Got it
      </button>
    </div>
  </Sheet>
);
