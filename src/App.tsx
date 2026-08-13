import React, { useCallback, useEffect, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { User } from './types';
import { clearAuthParamsFromUrl, messageFrom, readOAuthError } from './lib/authErrors';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/Confirm';
import { useOnline } from './lib/offline';
import { InstallPrompt } from './components/InstallPrompt';
import { AuthPage } from './pages/AuthPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { SearchPage } from './pages/SearchPage';
import { HomePage } from './pages/HomePage';
import { GroupsPage } from './pages/GroupsPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { FriendsPage } from './pages/FriendsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { SettingsPage } from './pages/SettingsPage';
import { Home, Users, UserCheck, BarChart3, Settings, WifiOff, RefreshCw } from 'lucide-react';

// Search is a utility, not a destination — it lives as a header action on Home
// rather than taking one of six already-tight nav slots from a core screen.
const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'groups', label: 'Groups', icon: Users },
  { id: 'friends', label: 'Friends', icon: UserCheck },
  { id: 'analytics', label: 'Stats', icon: BarChart3 },
  { id: 'settings', label: 'You', icon: Settings },
];

const SplashScreen: React.FC<{ label: string }> = ({ label }) => (
  <div
    style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      gap: 'var(--sp-4)',
    }}
  >
    <div
      style={{
        width: 68,
        height: 68,
        borderRadius: 22,
        background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 34,
        boxShadow: 'var(--shadow-primary)',
      }}
    >
      💰
    </div>
    <div className="row" style={{ gap: 10, color: 'var(--on-surface-variant)', fontWeight: 600 }}>
      <span className="spinner" />
      {label}
    </div>
  </div>
);

const AppShell: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  // Survive a reload. A refresh dropping you back to Home means losing your
  // place mid-task, which is exactly when people refresh.
  const [route, setRoute] = useState(() => {
    try {
      return sessionStorage.getItem('moneymate.route') || 'home';
    } catch {
      return 'home';
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem('moneymate.route', route);
    } catch {
      // Private mode — the app simply opens on Home next time.
    }
  }, [route]);
  const [recovering, setRecovering] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const online = useOnline();

  // Clear the note after a moment.
  useEffect(() => {
    if (!syncNote) return;
    const timer = window.setTimeout(() => setSyncNote(null), 4000);
    return () => window.clearTimeout(timer);
  }, [syncNote]);

  /**
   * Posts any recurring expenses that fell due while the app was closed. The
   * function is idempotent — next_run only moves forward — so running it on
   * every launch is safe.
   */
  useEffect(() => {
    if (!user || !online) return;
    void supabase
      .rpc('run_due_recurring')
      .then(({ data, error }) => {
        if (!error && typeof data === 'number' && data > 0) {
          setSyncNote(`Added ${data} recurring ${data === 1 ? 'expense' : 'expenses'}.`);
        }
      });
  }, [user?.id, online]);

  /**
   * Loads the profile row for a signed-in account, creating it if the
   * database trigger has not (or is not installed).
   *
   * Everything is wrapped: if this throws, `setLoading(false)` never runs and
   * the app hangs on the splash screen forever — which is exactly what a
   * failed Google redirect used to look like.
   */
  const loadProfile = useCallback(async (authUser: Session['user']) => {
    const fallbackName =
      authUser.user_metadata?.full_name ||
      authUser.user_metadata?.name ||
      authUser.email?.split('@')[0] ||
      'User';

    try {
      const { data: existing, error: readError } = await supabase
        .from('users')
        .select('*')
        .eq('id', authUser.id)
        .maybeSingle();

      if (readError) throw readError;

      if (existing) {
        setUser(existing as User);
        setProfileError(null);
        // Links any group invites / friend requests sent to this email before
        // the account existed. Best-effort — never blocks sign-in on it.
        void supabase.rpc('claim_pending_invitations').then(({ error: claimError }) => {
          if (claimError) console.error('claim_pending_invitations failed:', claimError);
        });
        return;
      }

      // No row yet — insert one rather than upsert, so a display name the user
      // edited in Settings is never overwritten by the provider's version.
      const { data: created, error: insertError } = await supabase
        .from('users')
        .insert({
          id: authUser.id,
          display_name: fallbackName,
          email: authUser.email || '',
          avatar_url: authUser.user_metadata?.avatar_url || authUser.user_metadata?.picture || null,
        })
        .select()
        .single();

      if (insertError) throw insertError;
      setUser(created as User);
      setProfileError(null);
      void supabase.rpc('claim_pending_invitations').then(({ error: claimError }) => {
        if (claimError) console.error('claim_pending_invitations failed:', claimError);
      });
    } catch (error) {
      // Still let the user in with what the token tells us, so a profile
      // hiccup does not lock them out of the whole app.
      console.error('Profile load failed:', error);
      setProfileError(messageFrom(error));
      setUser({
        id: authUser.id,
        display_name: fallbackName,
        email: authUser.email || '',
        avatar_url: authUser.user_metadata?.avatar_url,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;

    // An OAuth error arrives as a URL parameter and must be read before the
    // parameters are cleared below.
    const callbackError = readOAuthError();
    if (callbackError) {
      sessionStorage.setItem('moneymate.authError', callbackError.message);
    }

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        // Safe to clean the URL now: getSession() waits for supabase-js to
        // finish exchanging the PKCE code in the query string.
        clearAuthParamsFromUrl();
        setSession(data.session);
        if (data.session?.user) {
          void loadProfile(data.session.user);
        } else {
          setLoading(false);
        }
      })
      .catch((error) => {
        console.error('Session lookup failed:', error);
        if (!active) return;
        setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;

      // Following a reset link signs the user in with a recovery session. Catch
      // it so they get the "set a new password" screen rather than being
      // dropped into the app with the old password still in force.
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);

      setSession(nextSession);
      if (nextSession?.user) {
        void loadProfile(nextSession.user);
      } else {
        setUser(null);
        setRecovering(false);
        setLoading(false);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [loadProfile]);

  if (loading) return <SplashScreen label="Loading MoneyMate…" />;

  if (recovering && session) {
    return (
      <ToastProvider>
        <ResetPasswordPage
          onDone={() => setRecovering(false)}
          onCancel={async () => {
            await supabase.auth.signOut();
            setRecovering(false);
          }}
        />
      </ToastProvider>
    );
  }

  if (!session || !user) {
    return (
      <ToastProvider>
        <AuthPage />
      </ToastProvider>
    );
  }

  const handleSignedOut = () => {
    setSession(null);
    setUser(null);
    setRoute('home');
  };

  const renderPage = () => {
    if (route.startsWith('group-detail/')) {
      return (
        <GroupDetailPage
          groupId={route.replace('group-detail/', '')}
          user={user}
          onBack={() => setRoute('groups')}
        />
      );
    }

    switch (route) {
      case 'groups':
        return <GroupsPage user={user} onNavigate={setRoute} />;
      case 'search':
        return <SearchPage user={user} onNavigate={setRoute} />;
      case 'friends':
        return <FriendsPage user={user} />;
      case 'analytics':
        return <AnalyticsPage user={user} />;
      case 'settings':
        return <SettingsPage user={user} onUserUpdated={setUser} onSignedOut={handleSignedOut} />;
      default:
        return <HomePage user={user} onNavigate={setRoute} />;
    }
  };

  return (
    <ToastProvider>
      <ConfirmProvider>
        {!online && (
          <div className="offline-bar">
            <WifiOff size={13} />
            Offline · showing saved data
          </div>
        )}
        {online && syncNote && (
          <div className="offline-bar is-syncing">
            <RefreshCw size={13} /> {syncNote}
          </div>
        )}

        <InstallPrompt />

        {profileError && (
          <div style={{ padding: 'var(--sp-3) var(--sp-4) 0' }}>
            <div className="alert alert-warning">
              Working offline from your sign-in details — your profile could not be loaded. {profileError}
            </div>
          </div>
        )}

        {renderPage()}

        <nav className="bottom-nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const isActive =
              route === item.id || (item.id === 'groups' && route.startsWith('group-detail/'));
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setRoute(item.id)}
                className={`nav-item ${isActive ? 'is-active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className="nav-icon">
                  <Icon size={19} />
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </ConfirmProvider>
    </ToastProvider>
  );
};

/** Theme has to wrap everything, including the signed-out and recovery screens. */
export const App: React.FC = () => (
  <ThemeProvider>
    <AppShell />
  </ThemeProvider>
);
