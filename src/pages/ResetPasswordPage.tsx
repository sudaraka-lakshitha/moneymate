import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { friendlyAuthError } from '../lib/authErrors';
import { Alert, Spinner } from '../components/ui';
import { Eye, EyeOff, KeyRound } from 'lucide-react';

interface ResetPasswordPageProps {
  /** Called once the new password is saved and the user can continue. */
  onDone: () => void;
  onCancel: () => void;
}

/**
 * Shown when Supabase reports a PASSWORD_RECOVERY session — i.e. the user has
 * just followed a reset link. Without this screen the link signed them in but
 * gave them no way to actually set a new password, so the reset never completed.
 */
export const ResetPasswordPage: React.FC<ResetPasswordPageProps> = ({ onDone, onCancel }) => {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      onDone();
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 'var(--sp-10) var(--sp-5)', minHeight: '100vh' }}>
      <header style={{ textAlign: 'center', marginBottom: 'var(--sp-6)' }}>
        <div
          style={{
            width: 68,
            height: 68,
            borderRadius: 22,
            background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--shadow-primary)',
            marginBottom: 'var(--sp-4)',
            color: '#fff',
          }}
        >
          <KeyRound size={30} />
        </div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em' }}>Set a new password</h1>
        <p className="text-muted" style={{ fontSize: '0.9rem', marginTop: 6 }}>
          Choose a new password for your MoneyMate account.
        </p>
      </header>

      {error && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <form onSubmit={handleSubmit} className="stack">
        <div style={{ position: 'relative' }}>
          <input
            type={show ? 'text' : 'password'}
            className="input"
            style={{ paddingRight: 48 }}
            placeholder="New password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            autoFocus
            required
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? 'Hide password' : 'Show password'}
            style={{
              position: 'absolute',
              right: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--on-surface-variant)',
              display: 'flex',
            }}
          >
            {show ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>

        <input
          type={show ? 'text' : 'password'}
          className="input"
          placeholder="Confirm new password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          minLength={6}
          required
        />

        <span className="hint">At least 6 characters.</span>

        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={saving}>
          {saving && <Spinner />}
          {saving ? 'Saving…' : 'Save new password'}
        </button>

        <button type="button" className="btn btn-ghost btn-block" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </form>
    </div>
  );
};
