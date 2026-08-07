import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { LogIn, Sparkles, Shield, Users, BarChart3 } from 'lucide-react';

interface AuthPageProps {
  onSignedIn: () => void;
}

export const AuthPage: React.FC<AuthPageProps> = ({ onSignedIn }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (isSignUp) {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: displayName || email.split('@')[0] }
          }
        });
        if (error) throw error;
        if (data.user) onSignedIn();
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.user) onSignedIn();
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin }
      });
      if (error) throw error;
    } catch (err: any) {
      setError(err.message || 'Google sign-in failed');
    }
  };

  return (
    <div style={{ padding: '40px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      {/* Brand */}
      <div style={{
        width: 80, height: 80, borderRadius: 24,
        background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40,
        boxShadow: '0 12px 30px rgba(108, 99, 255, 0.4)', marginBottom: 20
      }}>
        💰
      </div>

      <h1 style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--on-background)', marginBottom: 6 }}>MoneyMate</h1>
      <p style={{ color: 'var(--on-surface-variant)', fontSize: '0.95rem', textAlign: 'center', marginBottom: 36 }}>
        Split bills · Track daily expenses · Settle in LKR
      </p>

      {/* Feature highlights */}
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
        {[
          { icon: Sparkles, text: 'LKR Currency only (Rs.)' },
          { icon: Users, text: 'Group & proxy expense splitting' },
          { icon: BarChart3, text: 'Personal budget & analytics' },
          { icon: Shield, text: 'Immutable ledger balance accuracy' },
        ].map((f, i) => (
          <div key={i} className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <f.icon size={18} color="var(--primary)" />
            <span style={{ fontSize: '0.9rem', color: 'var(--on-surface)' }}>{f.text}</span>
          </div>
        ))}
      </div>

      {/* Error alert */}
      {error && (
        <div style={{
          width: '100%', padding: '12px 16px', borderRadius: 14,
          background: 'rgba(255, 107, 107, 0.15)', border: '1px solid var(--negative)',
          color: 'var(--negative)', fontSize: '0.85rem', marginBottom: 16
        }}>
          {error}
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleAuth} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {isSignUp && (
          <input
            type="text"
            placeholder="Display Name"
            className="input-field"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        )}
        <input
          type="email"
          placeholder="Email address"
          className="input-field"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          className="input-field"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <button type="submit" className="btn-primary" disabled={loading} style={{ height: 52, marginTop: 6 }}>
          <LogIn size={20} />
          {loading ? 'Processing…' : isSignUp ? 'Create Account' : 'Sign In'}
        </button>
      </form>

      {/* Toggle Sign Up / Sign In */}
      <button
        onClick={() => setIsSignUp(!isSignUp)}
        style={{ background: 'none', border: 'none', color: 'var(--primary-light)', marginTop: 16, cursor: 'pointer', fontSize: '0.9rem' }}
      >
        {isSignUp ? 'Already have an account? Sign In' : "Don't have an account? Sign Up"}
      </button>

      {/* Divider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%', margin: '24px 0 16px' }}>
        <div style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
        <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>OR</span>
        <div style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
      </div>

      {/* Google Button */}
      <button
        onClick={handleGoogleSignIn}
        className="glass-card"
        style={{
          width: '100%', height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 12, cursor: 'pointer', border: '1px solid var(--card-border)', color: 'var(--on-background)',
          fontWeight: 600
        }}
      >
        <span>🔵</span> Continue with Google
      </button>
    </div>
  );
};
