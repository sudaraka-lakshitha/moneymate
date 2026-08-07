import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { friendlyDbError } from '../lib/authErrors';
import { Avatar, Sheet, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { LogOut, Pencil, Globe, Shield, Database, Github, ChevronRight } from 'lucide-react';

interface SettingsPageProps {
  user: User;
  onUserUpdated: (user: User) => void;
  onSignedOut: () => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ user, onUserUpdated, onSignedOut }) => {
  const toast = useToast();
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(user.display_name);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

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
    </div>
  );
};
