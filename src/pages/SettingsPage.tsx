import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { friendlyAuthError, friendlyDbError } from '../lib/authErrors';
import { ThemePreference, useTheme } from '../lib/theme';
import { Alert, Avatar, Sheet, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import {
  LogOut, Pencil, Globe, Shield, Database, Github, ChevronRight,
  Sun, Moon, Monitor, KeyRound,
} from 'lucide-react';

const THEME_OPTIONS: { id: ThemePreference; label: string; icon: React.ElementType }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'Auto', icon: Monitor },
];

interface SettingsPageProps {
  user: User;
  onUserUpdated: (user: User) => void;
  onSignedOut: () => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ user, onUserUpdated, onSignedOut }) => {
  const toast = useToast();
  const confirm = useConfirm();
  const { preference, resolved, setPreference } = useTheme();

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(user.display_name);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const [changingPassword, setChangingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);

    if (newPassword.length < 6) {
      setPasswordError('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('The two passwords do not match.');
      return;
    }

    setPasswordSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      toast.success('Password updated.');
      setChangingPassword(false);
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      setPasswordError(friendlyAuthError(error));
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleSendReset = async () => {
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
        redirectTo: window.location.origin + window.location.pathname,
      });
      if (error) throw error;
      toast.success(`Reset link sent to ${user.email}.`);
    } catch (error) {
      toast.error(friendlyAuthError(error));
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = draftName.trim();
    if (!name) {
      toast.error('Display name cannot be empty.');
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase
        .from('users')
        .update({ display_name: name })
        .eq('id', user.id)
        .select()
        .single();

      if (error) throw error;
      onUserUpdated(data as User);
      setEditing(false);
      toast.success('Profile updated.');
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not update your profile.'));
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = async () => {
    const ok = await confirm({
      title: 'Sign out?',
      message: 'You will need to sign in again to reach your groups and expenses.',
      confirmLabel: 'Sign out',
      danger: true,
    });
    if (!ok) return;

    setSigningOut(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      onSignedOut();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not sign out.'));
      setSigningOut(false);
    }
  };

  const infoRows = [
    { icon: Globe, label: 'Currency', value: 'LKR (Rs.)' },
    { icon: Database, label: 'Sync', value: 'Supabase, live' },
    { icon: Shield, label: 'Row Level Security', value: 'Enabled' },
  ];

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">You</h1>
      </header>

      <section className="card" style={{ textAlign: 'center', padding: 'var(--sp-6)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--sp-3)' }}>
          <Avatar name={user.display_name} url={user.avatar_url} size={76} />
        </div>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 800 }}>{user.display_name}</h2>
        <p className="text-muted" style={{ fontSize: '0.85rem', marginTop: 2 }}>
          {user.email}
        </p>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          style={{ marginTop: 'var(--sp-4)' }}
          onClick={() => {
            setDraftName(user.display_name);
            setEditing(true);
          }}
        >
          <Pencil size={14} /> Edit profile
        </button>
      </section>

      <h2 className="section-title" style={{ marginTop: 'var(--sp-6)', marginBottom: 'var(--sp-3)' }}>
        Appearance
      </h2>
      <div className="segmented" role="group" aria-label="Theme">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`segmented-option ${preference === option.id ? 'is-active' : ''}`}
            onClick={() => setPreference(option.id)}
            aria-pressed={preference === option.id}
          >
            <option.icon size={15} />
            {option.label}
          </button>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 'var(--sp-2)' }}>
        {preference === 'system'
          ? `Following your device — currently ${resolved}.`
          : `Always ${preference}.`}
      </p>

      <h2 className="section-title" style={{ marginTop: 'var(--sp-6)', marginBottom: 'var(--sp-3)' }}>
        Security
      </h2>
      <div className="card card-flush">
        <button
          type="button"
          className="list-row list-row-interactive"
          onClick={() => {
            setPasswordError(null);
            setChangingPassword(true);
          }}
        >
          <KeyRound size={18} color="var(--primary)" />
          <span className="grow" style={{ fontSize: '0.9rem', fontWeight: 500 }}>
            Change password
          </span>
          <ChevronRight size={16} color="var(--on-surface-faint)" />
        </button>
      </div>

      <h2 className="section-title" style={{ marginTop: 'var(--sp-6)', marginBottom: 'var(--sp-3)' }}>
        About this app
      </h2>
      <div className="card card-flush">
        {infoRows.map((row) => (
          <div key={row.label} className="list-row">
            <row.icon size={18} color="var(--primary-light)" />
            <span className="grow" style={{ fontSize: '0.9rem', fontWeight: 500 }}>
              {row.label}
            </span>
            <span className="hint">{row.value}</span>
          </div>
        ))}
        <a
          className="list-row list-row-interactive"
          href="https://github.com/sudaraka-lakshitha/moneymate"
          target="_blank"
          rel="noreferrer"
          style={{ color: 'inherit', textDecoration: 'none' }}
        >
          <Github size={18} color="var(--primary-light)" />
          <span className="grow" style={{ fontSize: '0.9rem', fontWeight: 500 }}>
            Source code
          </span>
          <ChevronRight size={16} color="var(--on-surface-faint)" />
        </a>
      </div>

      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className="btn btn-danger btn-block btn-lg"
        style={{ marginTop: 'var(--sp-6)' }}
      >
        {signingOut ? <Spinner /> : <LogOut size={18} />}
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>

      {editing && (
        <Sheet title="Edit profile" onClose={() => setEditing(false)}>
          <form onSubmit={handleSaveProfile} className="stack">
            <div className="field">
              <label className="label label-block" htmlFor="display-name">
                Display name
              </label>
              <input
                id="display-name"
                className="input"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                maxLength={60}
                autoFocus
                required
              />
              <span className="hint">This is what other members see in groups and balances.</span>
            </div>

            <div className="field">
              <label className="label label-block" htmlFor="email-readonly">
                Email
              </label>
              <input id="email-readonly" className="input" value={user.email} disabled />
              <span className="hint">Email is managed by your sign-in provider.</span>
            </div>

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={saving}>
              {saving && <Spinner />}
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </form>
        </Sheet>
      )}

      {changingPassword && (
        <Sheet title="Change password" onClose={() => setChangingPassword(false)}>
          <form onSubmit={handleChangePassword} className="stack">
            {passwordError && <Alert variant="error">{passwordError}</Alert>}

            <input
              type="password"
              className="input"
              placeholder="New password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={6}
              autoFocus
              required
            />
            <input
              type="password"
              className="input"
              placeholder="Confirm new password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={6}
              required
            />
            <span className="hint">At least 6 characters.</span>

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={passwordSaving}>
              {passwordSaving && <Spinner />}
              {passwordSaving ? 'Saving…' : 'Update password'}
            </button>

            <button type="button" className="btn btn-ghost btn-block" onClick={handleSendReset}>
              Email me a reset link instead
            </button>
            <span className="hint">
              Signed in with Google? Use the reset link to add a password you can also sign in with.
            </span>
          </form>
        </Sheet>
      )}
    </div>
  );
};
