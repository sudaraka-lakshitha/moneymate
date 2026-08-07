import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { LogOut, Smartphone, Globe, Moon, Shield } from 'lucide-react';

interface SettingsPageProps {
  user: User;
  onSignedOut: () => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ user, onSignedOut }) => {
  const [loading, setLoading] = useState(false);

  const handleSignOut = async () => {
    setLoading(true);
    await supabase.auth.signOut();
    onSignedOut();
  };

  return (
    <div style={{ padding: '20px 16px 100px' }}>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--on-background)', marginBottom: 20 }}>
        Settings
      </h2>

      <div className="glass-card" style={{ padding: 20, textAlign: 'center', marginBottom: 24 }}>
        <div style={{
          width: 72, height: 72, borderRadius: '50%', background: 'var(--primary-container)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px',
          fontSize: 28, fontWeight: 800, color: 'var(--primary-light)'
        }}>
          {user.display_name.charAt(0).toUpperCase()}
        </div>
        <h3 style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--on-background)' }}>{user.display_name}</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--on-surface-variant)', marginTop: 2 }}>{user.email}</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
        {[
          { icon: Smartphone, label: 'Cross-Platform Sync', value: 'Active (Supabase)' },
          { icon: Globe, label: 'Default Currency', value: 'LKR (Rs.)' },
          { icon: Moon, label: 'Theme Mode', value: 'Dark Mode' },
          { icon: Shield, label: 'Security & RLS', value: 'Enabled' },
        ].map((item, i) => (
          <div key={i} className="glass-card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <item.icon size={20} color="var(--primary-light)" />
              <span style={{ fontSize: '0.9rem', color: 'var(--on-background)', fontWeight: 500 }}>{item.label}</span>
            </div>
            <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>{item.value}</span>
          </div>
        ))}
      </div>

      <button
        onClick={handleSignOut}
        disabled={loading}
        className="glass-card"
        style={{
          width: '100%', padding: 16, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 10, border: '1px solid var(--negative)',
          color: 'var(--negative)', fontWeight: 700, cursor: 'pointer', background: 'rgba(255, 107, 107, 0.1)'
        }}
      >
        <LogOut size={20} /> Sign Out
      </button>
    </div>
  );
};
