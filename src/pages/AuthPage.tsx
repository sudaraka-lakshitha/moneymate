import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { friendlyAuthError } from '../lib/authErrors';
import { Alert, GoogleIcon, Spinner } from '../components/ui';
import { Eye, EyeOff, LogIn, Sparkles, Shield, Users, BarChart3 } from 'lucide-react';

type Mode = 'signIn' | 'signUp';

const FEATURES = [
  { icon: Users, text: 'Split group bills four ways — equal, custom, % or shares' },
  { icon: Sparkles, text: 'Everything in LKR, down to the last cent' },
  { icon: BarChart3, text: 'Daily tracker, budgets and 30-day trends' },
  { icon: Shield, text: 'Append-only ledger keeps balances honest' },
];

export const AuthPage: React.FC = () => {
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [googlePending, setGooglePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // App.tsx parks any OAuth callback error here before scrubbing the URL.
  useEffect(() => {
    const stored = sessionStorage.getItem('moneymate.authError');
    if (stored) {
      setError(stored);
      sessionStorage.removeItem('moneymate.authError');
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (mode === 'signUp' && password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'signUp') {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: displayName.trim() || email.split('@')[0] },
            emailRedirectTo: window.location.origin + window.location.pathname,
          },
        });
        if (signUpError) throw signUpError;

        // With email confirmation on, there is a user but no session yet.
        // Without this branch the screen just sits there looking broken.
        if (data.user && !data.session) {
          setNotice(`Almost there — we sent a confirmation link to ${email.trim()}. Click it, then sign in.`);
          setMode('signIn');
          setPassword('');
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
      }
      // On success App's onAuthStateChange takes over and swaps this screen out.
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setNotice(null);
    setGooglePending(true);

    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          // Include the pathname so the app still works when it is not served
          // from the domain root.
          redirectTo: window.location.origin + window.location.pathname,
          queryParams: { prompt: 'select_account' },
        },
      });
      // A returned error means the redirect never happened.
      if (oauthError) throw oauthError;
    } catch (err) {
      setError(friendlyAuthError(err));
      setGooglePending(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError('Enter your email address first, then tap "Forgot password".');
      return;
    }
    setError(null);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin + window.location.pathname,
      });
      if (resetError) throw resetError;
      setNotice(`Password reset link sent to ${email.trim()}.`);
    } catch (err) {
      setError(friendlyAuthError(err));
    }
  };

  const isSignUp = mode === 'signUp';

  return (
    <div style={{ padding: 'var(--sp-8) var(--sp-5) var(--sp-10)', minHeight: '100vh' }}>
      <header style={{ textAlign: 'center', marginBottom: 'var(--sp-6)' }}>
        <div
          style={{
            width: 76,
            height: 76,
            borderRadius: 24,
            background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 38,
            boxShadow: 'var(--shadow-primary)',
            marginBottom: 'var(--sp-4)',
          }}
        >
          💰
        </div>
        <h1 style={{ fontSize: '1.9rem', fontWeight: 800, letterSpacing: '-0.03em' }}>MoneyMate</h1>
        <p className="text-muted" style={{ fontSize: '0.92rem', marginTop: 4 }}>
          Split smarter, settle faster.
        </p>
      </header>

      <div className="stack-sm" style={{ marginBottom: 'var(--sp-6)' }}>
        {FEATURES.map((feature) => (
          <div key={feature.text} className="card row" style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
            <feature.icon size={17} color="var(--primary-light)" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: '0.85rem', color: 'var(--on-surface)' }}>{feature.text}</span>
          </div>
        ))}
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      {notice && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="success">{notice}</Alert>
        </div>
      )}

      {/* Google first: it is the fastest path and should not be buried. */}
      <button
        type="button"
        onClick={handleGoogleSignIn}
        className="btn btn-secondary btn-block btn-lg"
        disabled={googlePending || submitting}
      >
        {googlePending ? <Spinner /> : <GoogleIcon size={18} />}
        {googlePending ? 'Redirecting to Google…' : 'Continue with Google'}
      </button>

      <div className="row" style={{ margin: 'var(--sp-5) 0' }}>
        <div style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
        <span className="hint">or use email</span>
        <div style={{ flex: 1, height: 1, background: 'var(--card-border)' }} />
      </div>

      <form onSubmit={handleSubmit} className="stack">
        {isSignUp && (
          <input
            type="text"
            className="input"
            placeholder="Display name"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        )}

        <input
          type="email"
          className="input"
          placeholder="Email address"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <div style={{ position: 'relative' }}>
          <input
            type={showPassword ? 'text' : 'password'}
            className="input"
            style={{ paddingRight: 48 }}
            placeholder="Password"
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={isSignUp ? 6 : undefined}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            style={{
              position: 'absolute',
              right: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--on-surface-variant)',
              display: 'flex',
            }}
          >
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>

        {isSignUp && <span className="hint">At least 6 characters.</span>}

        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={submitting || googlePending}>
          {submitting ? <Spinner /> : <LogIn size={18} />}
          {submitting ? 'Please wait…' : isSignUp ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <div className="row-between" style={{ marginTop: 'var(--sp-4)' }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setMode(isSignUp ? 'signIn' : 'signUp');
            setError(null);
            setNotice(null);
          }}
        >
          {isSignUp ? 'Have an account? Sign in' : 'New here? Create an account'}
        </button>

        {!isSignUp && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleForgotPassword}>
            Forgot password
          </button>
        )}
      </div>
    </div>
  );
};
