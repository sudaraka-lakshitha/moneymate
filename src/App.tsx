import React, { useCallback, useEffect, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { User } from './types';
import { clearAuthParamsFromUrl, readOAuthError } from './lib/authErrors';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/Confirm';
import { AuthPage } from './pages/AuthPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { HomePage } from './pages/HomePage';
import { GroupsPage } from './pages/GroupsPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { FriendsPage } from './pages/FriendsPage';
import { TrackerPage } from './pages/TrackerPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { SettingsPage } from './pages/SettingsPage';
import { Home, Users, UserCheck, Calendar, BarChart3, Settings } from 'lucide-react';

const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'groups', label: 'Groups', icon: Users },
  { id: 'friends', label: 'Friends', icon: UserCheck },
  { id: 'tracker', label: 'Tracker', icon: Calendar },
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
  const [route, setRoute] = useState('home');
  const [recovering, setRecovering] = useState(false);

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
    } catch (error) {
      // Still let the user in with what the token tells us, so a profile
      // hiccup does not lock them out of the whole app.
      console.error('Profile load failed:', error);
      setProfileError(error instanceof Error ? error.message : String(error));
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
      case 'friends':
        return <FriendsPage user={user} />;
      case 'tracker':
        return <TrackerPage user={user} />;
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
