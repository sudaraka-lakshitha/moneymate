import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { FriendBalance, User } from '../types';
import { formatLKR, formatLKRSigned } from '../lib/currency';
import { Search } from 'lucide-react';

interface FriendsPageProps {
  user: User;
}

export const FriendsPage: React.FC<FriendsPageProps> = ({ user }) => {
  const [friends, setFriends] = useState<FriendBalance[]>([]);
  const [search, setSearch] = useState('');
  const [totalOwed, setTotalOwed] = useState(0);
  const [totalOwing, setTotalOwing] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadFriendBalances();
  }, [user.id]);

  const loadFriendBalances = async () => {
    try {
      const { data: myGroups } = await supabase
        .from('group_members')
        .select('group_id')
        .eq('user_id', user.id);

      if (!myGroups) return;
      const groupIds = myGroups.map((g) => g.group_id);

      const { data: coMembers } = await supabase
        .from('group_members')
        .select('user_id, users(*)')
        .in('group_id', groupIds)
        .neq('user_id', user.id);

      if (!coMembers) return;

      const friendMap: Record<string, { user: User; count: number }> = {};
      coMembers.forEach((m: any) => {
        if (!friendMap[m.user_id]) {
          friendMap[m.user_id] = { user: m.users, count: 1 };
        } else {
          friendMap[m.user_id].count += 1;
        }
      });

      const { data: ledgerData } = await supabase
        .from('ledger_entries')
        .select('user_id, amount, group_id')
        .in('group_id', groupIds);

      const fList: FriendBalance[] = [];
      let sumOwed = 0;
      let sumOwing = 0;

      for (const [friendId, info] of Object.entries(friendMap)) {
        const friendLedger = (ledgerData || []).filter((l) => l.user_id === friendId);
        const net = friendLedger.reduce((acc, row) => acc + Number(row.amount), 0);

        if (net > 0) sumOwed += net;
        if (net < 0) sumOwing += Math.abs(net);

        fList.push({
          friend: info.user,
          net_balance: net,
          total_they_owe_me: net > 0 ? net : 0,
          total_i_owe_them: net < 0 ? Math.abs(net) : 0,
          shared_group_count: info.count,
        });
      }

      setFriends(fList);
      setTotalOwed(sumOwed);
      setTotalOwing(sumOwing);
    } catch (err) {
      console.error('Friends load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const filtered = friends.filter((f) =>
    f.friend.display_name.toLowerCase().includes(search.toLowerCase())
  );

  const overallNet = totalOwed - totalOwing;
  const isPositive = overallNet >= 0;

  return (
    <div style={{ padding: '20px 16px 100px' }}>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--on-background)', marginBottom: 20 }}>
        Friends Balance Panel
      </h2>

      <div className={isPositive ? 'glass-card-positive' : 'glass-card-negative'} style={{ padding: 20, marginBottom: 20 }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>Overall Friends Balance</span>
        <h2 style={{ fontSize: '2rem', fontWeight: 800, color: isPositive ? 'var(--positive)' : 'var(--negative)', margin: '6px 0 4px' }}>
          {formatLKRSigned(overallNet)}
        </h2>
        <span style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>
          {isPositive ? 'You are owed across all friends' : 'You owe across all friends'}
        </span>
      </div>

      <div className="glass-card" style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Search size={18} color="var(--on-surface-variant)" />
        <input
          type="text"
          placeholder="Search friends…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ background: 'none', border: 'none', color: 'var(--on-background)', outline: 'none', width: '100%', fontSize: '0.9rem' }}
        />
      </div>

      {filtered.length === 0 && !loading ? (
        <div className="glass-card" style={{ padding: 36, textAlign: 'center' }}>
          <span style={{ fontSize: 44 }}>🤝</span>
          <h3 style={{ marginTop: 12, fontSize: '1rem', color: 'var(--on-background)' }}>No friends found</h3>
          <p style={{ color: 'var(--on-surface-variant)', fontSize: '0.85rem', marginTop: 4 }}>
            Join groups and split bills to see friend balances here.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((item) => (
            <div key={item.friend.id} className="glass-card" style={{ padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%', background: 'var(--primary-container)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
                  fontWeight: 700, color: 'var(--primary-light)'
                }}>
                  {item.friend.display_name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--on-background)' }}>{item.friend.display_name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>Shared in {item.shared_group_count} group(s)</div>
                </div>
              </div>

              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontWeight: 700, fontSize: '0.95rem',
                  color: item.net_balance > 0 ? 'var(--positive)' : item.net_balance < 0 ? 'var(--negative)' : 'var(--neutral)'
                }}>
                  {formatLKRSigned(item.net_balance)}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>
                  {item.net_balance > 0 ? 'owes you' : item.net_balance < 0 ? 'you owe' : 'settled'}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
