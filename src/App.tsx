import React, { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { User } from './types';
import { AuthPage } from './pages/AuthPage';
import { HomePage } from './pages/HomePage';
import { GroupsPage } from './pages/GroupsPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { FriendsPage } from './pages/FriendsPage';
import { TrackerPage } from './pages/TrackerPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { SettingsPage } from './pages/SettingsPage';
import { Home, Users, UserCheck, Calendar, BarChart3, Settings } from 'lucide-react';

export const App: React.FC = () => {
  const [session, setSession] = useState<any>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentRoute, setCurrentRoute] = useState<string>('home');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) setupUser(session.user);
      else setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session?.user) setupUser(session.user);
      else {
        setUser(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const setupUser = async (authUser: any) => {
    const displayName = authUser.user_metadata?.full_name || authUser.email?.split('@')[0] || 'User';
    const email = authUser.email || '';
    const avatarUrl = authUser.user_metadata?.avatar_url;

    const { data, error } = await supabase
      .from('users')
      .upsert({ id: authUser.id, display_name: displayName, email, avatar_url: avatarUrl }, { onConflict: 'id' })
      .select()
      .single();

    if (data) {
      setUser(data);
    } else {
      setUser({ id: authUser.id, display_name: displayName, email, avatar_url: avatarUrl });
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--background)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>💰</div>
          <div style={{ color: 'var(--primary-light)', fontWeight: 600 }}>Loading MoneyMate…</div>
        </div>
      </div>
    );
  }

  if (!session || !user) {
    return <AuthPage onSignedIn={() => setLoading(true)} />;
  }

  const renderContent = () => {
    if (currentRoute.startsWith('group-detail/')) {
      const groupId = currentRoute.replace('group-detail/', '');
      return <GroupDetailPage groupId={groupId} user={user} onBack={() => setCurrentRoute('groups')} />;
    }

    switch (currentRoute) {
      case 'home':
        return <HomePage user={user} onNavigate={setCurrentRoute} />;
      case 'groups':
        return <GroupsPage user={user} onNavigate={setCurrentRoute} />;
      case 'friends':
        return <FriendsPage user={user} />;
      case 'tracker':
        return <TrackerPage user={user} />;
      case 'analytics':
        return <AnalyticsPage user={user} />;
      case 'settings':
        return <SettingsPage user={user} onSignedOut={() => setSession(null)} />;
      default:
        return <HomePage user={user} onNavigate={setCurrentRoute} />;
    }
  };

  const navItems = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'groups', label: 'Groups', icon: Users },
    { id: 'friends', label: 'Friends', icon: UserCheck },
    { id: 'tracker', label: 'Tracker', icon: Calendar },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      {renderContent()}

      <nav className="bottom-nav">
        {navItems.map((item) => {
          const isActive = currentRoute === item.id || (item.id === 'groups' && currentRoute.startsWith('group-detail/'));
          const IconComponent = item.icon;

          return (
            <button
              key={item.id}
              onClick={() => setCurrentRoute(item.id)}
              className={`nav-item ${isActive ? 'active' : ''}`}
            >
              <div className="nav-icon-box">
                <IconComponent size={20} />
              </div>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
