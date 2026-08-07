import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Group, Expense, User } from '../types';
import { formatLKR, formatLKRSigned } from '../lib/currency';

interface HomePageProps {
  user: User;
  onNavigate: (route: string) => void;
}

export const HomePage: React.FC<HomePageProps> = ({ user, onNavigate }) => {
  const [netBalance, setNetBalance] = useState(0);
  const [totalOwed, setTotalOwed] = useState(0);
  const [totalOwing, setTotalOwing] = useState(0);
  const [groups, setGroups] = useState<Group[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadHomeData();
  }, [user.id]);

  const loadHomeData = async () => {
    try {
      const { data: memberData } = await supabase
        .from('group_members')
        .select('group_id, groups(*)')
        .eq('user_id', user.id);

      if (memberData) {
        const groupList = memberData.map((m: any) => m.groups).filter(Boolean);
        setGroups(groupList);
      }

      const { data: ledgerData } = await supabase
        .from('ledger_entries')
        .select('amount')
        .eq('user_id', user.id);

      if (ledgerData) {
        const net = ledgerData.reduce((acc, row) => acc + Number(row.amount), 0);
        setNetBalance(net);
        const owed = ledgerData.filter((r) => r.amount > 0).reduce((acc, row) => acc + Number(row.amount), 0);
        const owing = ledgerData.filter((r) => r.amount < 0).reduce((acc, row) => acc + Math.abs(Number(row.amount)), 0);
        setTotalOwed(owed);
        setTotalOwing(owing);
      }

      const { data: expenseData } = await supabase
        .from('expenses')
        .select('*')
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(10);

      if (expenseData) setExpenses(expenseData);
    } catch (err) {
      console.error('Home load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const isPositive = netBalance >= 0;

  return (
    <div style={{ padding: '20px 16px 100px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <span style={{ fontSize: '0.85rem', color: 'var(--on-surface-variant)' }}>Welcome back,</span>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--on-background)' }}>{user.display_name}</h2>
        </div>
        <div style={{
          width: 44, height: 44, borderRadius: '50%', background: 'var(--primary-container)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--primary-light)', fontWeight: 700, fontSize: '1.1rem'
        }}>
          {user.display_name.charAt(0).toUpperCase()}
        </div>
      </div>

      <div className={isPositive ? 'glass-card-positive' : 'glass-card-negative'} style={{ padding: 24, marginBottom: 24 }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--on-surface-variant)' }}>Overall Balance</span>
        <h1 style={{
          fontSize: '2.4rem', fontWeight: 800, margin: '8px 0 4px',
          color: isPositive ? 'var(--positive)' : 'var(--negative)'
        }}>
          {formatLKRSigned(netBalance)}
        </h1>
        <p style={{ fontSize: '0.8rem', color: 'var(--on-surface-variant)', marginBottom: 20 }}>
          {isPositive ? 'You are owed in total across all groups' : 'You owe in total across all groups'}
        </p>
        <div style={{ display: 'flex', gap: 24, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 16 }}>
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>You are owed</span>
            <div style={{ fontWeight: 700, color: 'var(--positive)', fontSize: '1rem' }}>{formatLKR(totalOwed)}</div>
          </div>
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>You owe</span>
            <div style={{ fontWeight: 700, color: 'var(--negative)', fontSize: '1rem' }}>{formatLKR(totalOwing)}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 28 }}>
        {[
          { emoji: '➕', label: 'Add Bill', action: () => onNavigate('groups') },
          { emoji: '👥', label: 'New Group', action: () => onNavigate('groups') },
          { emoji: '🔗', label: 'Join Code', action: () => onNavigate('groups') },
          { emoji: '💸', label: 'Settle Up', action: () => onNavigate('friends') },
        ].map((item, i) => (
          <button
            key={i}
            onClick={item.action}
            className="glass-card"
            style={{
              padding: '14px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center',
              gap: 6, cursor: 'pointer', border: '1px solid var(--card-border)', background: 'var(--surface-variant)'
            }}
          >
            <span style={{ fontSize: 22 }}>{item.emoji}</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--on-surface)', fontWeight: 600 }}>{item.label}</span>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--on-background)' }}>Active Groups</h3>
        <button onClick={() => onNavigate('groups')} style={{ background: 'none', border: 'none', color: 'var(--primary-light)', fontSize: '0.85rem', cursor: 'pointer' }}>
          See all
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="glass-card" style={{ padding: 24, textAlign: 'center', marginBottom: 28 }}>
          <span style={{ fontSize: 40 }}>👥</span>
          <p style={{ marginTop: 8, color: 'var(--on-surface-variant)', fontSize: '0.9rem' }}>No groups yet. Create or join one!</p>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, marginBottom: 28 }}>
          {groups.map((group) => (
            <div
              key={group.id}
              onClick={() => onNavigate(`group-detail/${group.id}`)}
              className="glass-card"
              style={{
                minWidth: 140, padding: 16, display: 'flex', flexDirection: 'column',
                alignItems: 'center', cursor: 'pointer', flexShrink: 0
              }}
            >
              <span style={{ fontSize: 32, marginBottom: 8 }}>{group.icon_emoji}</span>
              <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--on-background)', marginBottom: 4 }}>{group.name}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>Tap to view</span>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--on-background)', marginBottom: 12 }}>Recent Activity</h3>
      {expenses.length === 0 ? (
        <div className="glass-card" style={{ padding: 24, textAlign: 'center' }}>
          <span style={{ fontSize: 36 }}>📋</span>
          <p style={{ marginTop: 8, color: 'var(--on-surface-variant)', fontSize: '0.9rem' }}>No recent activity</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {expenses.map((expense) => (
            <div key={expense.id} className="glass-card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--surface-variant)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>
                  📌
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--on-background)' }}>{expense.title}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>{new Date(expense.created_at).toLocaleDateString()}</div>
                </div>
              </div>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--on-background)' }}>
                {formatLKR(expense.amount)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
