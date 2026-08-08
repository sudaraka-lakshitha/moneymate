import React, { useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { friendlyAuthError, friendlyDbError, messageFrom } from '../lib/authErrors';
import { removeOldAvatar, uploadAvatar } from '../lib/avatars';
import { ThemePreference, useTheme } from '../lib/theme';
import { Alert, Avatar, Sheet, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { useInstall } from '../lib/install';
import { IosInstallHelp } from '../components/InstallPrompt';
import {
  LogOut, Pencil, Globe, Info, ChevronRight,
  Sun, Moon, Monitor, KeyRound, Camera, Trash2, Download, Check,
} from 'lucide-react';

const APP_VERSION = '1.0.0';

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
  const [deleting, setDeleting] = useState(false);

  const install = useInstall();
  const [showIosHelp, setShowIosHelp] = useState(false);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

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

  const applyAvatar = async (nextUrl: string | null) => {
    const previous = user.avatar_url;

    const { data, error } = await supabase
      .from('users')
      .update({ avatar_url: nextUrl })
      .eq('id', user.id)
      .select()
      .single();
    if (error) throw error;

    onUserUpdated(data as User);
    // Only after the row points somewhere else is the old file safe to drop.
    void removeOldAvatar(previous);
  };

  const handlePickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset immediately so picking the same file twice still fires onChange.
    e.target.value = '';
    if (!file) return;

    setUploadingPhoto(true);
    try {
      const url = await uploadAvatar(file, user.id);
      await applyAvatar(url);
      toast.success('Profile picture updated.');
    } catch (error) {
      toast.error(messageFrom(error) || 'Could not update your picture.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleRemovePhoto = async () => {
    const ok = await confirm({
      title: 'Remove your picture?',
      message: 'Your initial will be shown instead, in your groups and to your friends.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;

    setUploadingPhoto(true);
    try {
      await applyAvatar(null);
      toast.info('Picture removed.');
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not remove your picture.'));
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleDeleteAccount = async () => {
    const first = await confirm({
      title: 'Delete your account?',
      message:
        'Your profile, personal expenses, budgets and friendships are erased permanently. Groups you share stay for the other members, and past shared bills remain on their records. This cannot be undone.',
      confirmLabel: 'Continue',
      danger: true,
    });
    if (!first) return;

    // Two steps on purpose: this is the one action in the app with no way back.
    const second = await confirm({
      title: 'Really delete everything?',
      message: `This will permanently close the account for ${user.email}. There is no undo and no recovery.`,
      confirmLabel: 'Delete my account',
      danger: true,
    });
    if (!second) return;

    setDeleting(true);
    try {
      const { error } = await supabase.rpc('delete_my_account');
      if (error) throw error;
      await supabase.auth.signOut();
      onSignedOut();
    } catch (error) {
      // The commonest refusal is an unsettled balance, and the server says so.
      toast.error(friendlyDbError(error, 'Could not delete your account.'));
      setDeleting(false);
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

  // Only things a person using the app would want to know. What the backend is
  // called and which database features are switched on are our concerns, not
  // theirs — and listing them reads like a debug screen.
  const infoRows = [
    { icon: Globe, label: 'Currency', value: 'LKR (Rs.)' },
    { icon: Info, label: 'Version', value: APP_VERSION },
  ];

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">You</h1>
      </header>

      <section className="card" style={{ textAlign: 'center', padding: 'var(--sp-6)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--sp-3)' }}>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <Avatar name={user.display_name} url={user.avatar_url} size={76} />
            <button
              type="button"
              className="btn-icon"
              onClick={() => photoInputRef.current?.click()}
              disabled={uploadingPhoto}
              aria-label="Change profile picture"
              style={{
                position: 'absolute',
                right: -4,
                bottom: -4,
                width: 30,
                height: 30,
                background: 'var(--primary)',
                color: '#fff',
                border: '2px solid var(--surface)',
              }}
            >
              {uploadingPhoto ? <Spinner size={13} /> : <Camera size={14} />}
            </button>
          </span>
        </div>

        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          onChange={handlePickPhoto}
          style={{ display: 'none' }}
        />

        <h2 style={{ fontSize: '1.2rem', fontWeight: 800 }}>{user.display_name}</h2>
        <p className="text-muted" style={{ fontSize: '0.85rem', marginTop: 2 }}>
          {user.email}
        </p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 'var(--sp-4)' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setDraftName(user.display_name);
              setEditing(true);
            }}
          >
            <Pencil size={14} /> Edit profile
          </button>
          {user.avatar_url && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleRemovePhoto}
              disabled={uploadingPhoto}
            >
              <Trash2 size={14} /> Remove photo
            </button>
          )}
        </div>
      </section>

      {/* Always present, so dismissing the install banner is never a dead end. */}
      <h2 className="section-title" style={{ marginTop: 'var(--sp-6)', marginBottom: 'var(--sp-3)' }}>
        App
      </h2>
      <div className="card row">
        <span
          className="icon-tile"
          style={{ width: 38, height: 38, background: 'var(--primary-container)', color: 'var(--primary)' }}
        >
          {install.isInstalled ? <Check size={18} /> : <Download size={18} />}
        </span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem' }}>
            {install.isInstalled ? 'Installed' : 'Install MoneyMate'}
          </span>
          <span className="hint">
            {install.isInstalled
              ? 'Running as an installed app.'
              : install.canInstall
                ? 'Adds it to your app drawer and runs it full screen.'
                : install.needsIosInstructions
                  ? 'Add it to your Home Screen from Safari.'
                  : install.isIosUnsupportedBrowser
                    ? 'Open this site in Safari to install it.'
                    : 'Your browser has not offered install yet — keep using the app, or try Chrome.'}
          </span>
        </span>
        {!install.isInstalled &&
          (install.canInstall ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void install.promptInstall()}
            >
              Install
            </button>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowIosHelp(true)}>
              How
            </button>
          ))}
      </div>

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

      <div className="card" style={{ borderColor: 'var(--negative)', marginTop: 'var(--sp-6)' }}>
        <span className="row" style={{ gap: 8, marginBottom: 6 }}>
          <Trash2 size={16} color="var(--negative)" />
          <span style={{ fontWeight: 700, fontSize: '0.93rem' }}>Delete account</span>
        </span>
        <p className="hint" style={{ marginBottom: 'var(--sp-3)' }}>
          Erases your profile, personal expenses, budgets and friendships for good. Settle every balance
          first — an unsettled account cannot be deleted, because it would leave somebody else's books
          short.
        </p>
        <button
          type="button"
          className="btn btn-danger btn-block"
          onClick={handleDeleteAccount}
          disabled={deleting}
        >
          {deleting && <Spinner />}
          {deleting ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>

      {showIosHelp && <IosInstallHelp onClose={() => setShowIosHelp(false)} />}
    </div>
  );
};
