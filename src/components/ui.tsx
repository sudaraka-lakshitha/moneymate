import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/* ---------------------------------------------------------------- Avatar */

interface AvatarProps {
  name?: string;
  url?: string | null;
  size?: number;
  title?: string;
}

export const Avatar: React.FC<AvatarProps> = ({ name, url, size = 40, title }) => {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className="avatar"
      title={title || name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {url ? <img src={url} alt="" referrerPolicy="no-referrer" /> : initial}
    </span>
  );
};

/* ----------------------------------------------------------------- Spinner */

export const Spinner: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
);

/* ------------------------------------------------------------------ Alert */

type AlertVariant = 'error' | 'success' | 'warning' | 'info';

export const Alert: React.FC<{ variant?: AlertVariant; children: React.ReactNode }> = ({
  variant = 'info',
  children,
}) => (
  <div className={`alert alert-${variant}`} role={variant === 'error' ? 'alert' : 'status'}>
    <span className="grow">{children}</span>
  </div>
);

/* ------------------------------------------------------------- EmptyState */

interface EmptyStateProps {
  icon: string;
  title: string;
  text?: string;
  action?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, text, action }) => (
  <div className="empty-state">
    <span className="empty-icon" aria-hidden="true">{icon}</span>
    <h3 className="empty-title">{title}</h3>
    {text && <p className="empty-text">{text}</p>}
    {action && <div className="empty-action">{action}</div>}
  </div>
);

/* --------------------------------------------------------------- Skeleton */

export const Skeleton: React.FC<{ height?: number | string; width?: number | string; radius?: number }> = ({
  height = 16,
  width = '100%',
  radius,
}) => <div className="skeleton" style={{ height, width, borderRadius: radius }} />;

/** Placeholder rows that mirror the shape of a loaded list. */
export const SkeletonRows: React.FC<{ count?: number; height?: number }> = ({ count = 3, height = 68 }) => (
  <div className="stack">
    {Array.from({ length: count }).map((_, i) => (
      <Skeleton key={i} height={height} radius={18} />
    ))}
  </div>
);

/* ------------------------------------------------------------------ Sheet */

interface SheetProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/**
 * Bottom sheet. Closes on backdrop click and Escape, and locks background
 * scrolling while open so the page behind does not drift.
 */
export const Sheet: React.FC<SheetProps> = ({ title, onClose, children, footer }) => {
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-sheet" ref={sheetRef} onClick={(e) => e.stopPropagation()}>
        <div className="modal-grabber" />
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer}
      </div>
    </div>
  );
};

/* --------------------------------------------------------------- Progress */

/* ------------------------------------------------------------ Google mark */

/** Official four-colour Google "G". An emoji here reads as a broken image. */
export const GoogleIcon: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
    <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
    <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
    <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
  </svg>
);
