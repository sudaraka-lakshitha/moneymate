import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useLiveRefresh } from '../lib/realtime';
import { Expense, Group, User } from '../types';
import { formatLKR, formatLKRSigned, roundMoney } from '../lib/currency';
import { computeFriendBalances, GroupLedger, netByUser } from '../lib/balances';
import { categoryMeta } from '../lib/categories';
import { friendlyDate } from '../lib/dates';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, Avatar, EmptyState, Skeleton, SkeletonRows } from '../components/ui';
import { Plus, Search, Users2, Wallet } from 'lucide-react';

interface HomePageProps {
  user: User;
  onNavigate: (route: string) => void;
}

export const HomePage: React.FC<HomePageProps> = ({ user, onNavigate }) => {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupBalances, setGroupBalances] = useState<Record<string, number>>({});
  const [recent, setRecent] = useState<Expense[]>([]);
  const [owedToMe, setOwedToMe] = useState(0);
  const [owedByMe, setOwedByMe] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data: memberships, error: membershipError } = await supabase
        .from('group_members')
        .select('group_id, groups(*)')
        .eq('user_id', user.id);
      if (membershipError) throw membershipError;

      const myGroups = (memberships ?? []).map((row: any) => row.groups).filter(Boolean) as Group[];

      // Direct 1:1 groups back friend loans. They must stay in the balance
      // maths below — a loan is real money — but they are not groups you browse,
      // so they are kept out of the "Your groups" list.
      setGroups(myGroups.filter((g) => !g.is_direct));

      const groupIds = myGroups.map((g) => g.id);

      if (groupIds.length > 0) {
        const [memberRes, ledgerRes, expenseRes] = await Promise.all([
          supabase.from('group_members').select('group_id, user_id, users(*)').in('group_id', groupIds),
          supabase.from('ledger_entries').select('group_id, user_id, amount').in('group_id', groupIds),
          supabase
            .from('expenses')
            .select('*, paid_by_user:users!expenses_paid_by_fkey(*)')
            .in('group_id', groupIds)
            .eq('is_deleted', false)
            .order('created_at', { ascending: false })
            .limit(6),
        ]);

        if (ledgerRes.error) throw ledgerRes.error;
        if (expenseRes.error) throw expenseRes.error;

        setRecent((expenseRes.data ?? []) as Expense[]);

        const perGroup: Record<string, number> = {};
        for (const row of ledgerRes.data ?? []) {
          if (row.user_id !== user.id) continue;
          perGroup[row.group_id] = roundMoney((perGroup[row.group_id] ?? 0) + Number(row.amount));
        }
        setGroupBalances(perGroup);

        // Headline figures come from pairwise friend balances so they agree
        // with what the Friends screen shows.
        const ledgers: GroupLedger[] = myGroups.map((group) => ({
          groupId: group.id,
          groupName: group.name,
          balances: netByUser((ledgerRes.data ?? []).filter((row: any) => row.group_id === group.id)),
          members: Object.fromEntries(
            (memberRes.data ?? [])
              .filter((row: any) => row.group_id === group.id && row.users)
              .map((row: any) => [row.user_id, row.users as User])
          ),
        }));

        let toMe = 0;
        let byMe = 0;
        for (const friend of computeFriendBalances(ledgers, user.id)) {
          if (friend.net_balance > 0) toMe += friend.net_balance;
          else byMe += Math.abs(friend.net_balance);
        }
        setOwedToMe(roundMoney(toMe));
        setOwedByMe(roundMoney(byMe));
      }

    } catch (err) {
      setError(friendlyDbError(err, 'Could not load your dashboard.'));
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveRefresh('home', ['expenses','ledger_entries','group_members'], load);

  const netBalance = roundMoney(owedToMe - owedByMe);
  const isPositive = netBalance >= 0;
  const settled = Math.abs(netBalance) < 0.01;

  const quickActions = [
    { icon: Plus, label: 'Add bill', route: 'groups' },
    { icon: Users2, label: 'New group', route: 'groups' },
    { icon: Search, label: 'Search', route: 'search' },
    { icon: Wallet, label: 'Settle up', route: 'friends' },
  ];

  const firstName = user.display_name.split(' ')[0];

  return (
    <div className="page">
      <header className="row-between" style={{ marginBottom: 'var(--sp-5)' }}>
        <div style={{ minWidth: 0 }}>
          <span className="hint">Welcome back,</span>
          <h1 className="page-title truncate">{firstName}</h1>
        </div>
        <span className="row" style={{ gap: 'var(--sp-2)', flexShrink: 0 }}>
          <button
            type="button"
            className="btn-icon"
            onClick={() => onNavigate('search')}
            aria-label="Search expenses"
          >
            <Search size={18} />
          </button>
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            aria-label="Open your profile"
            style={{ display: 'flex' }}
          >
            <Avatar name={user.display_name} url={user.avatar_url} size={44} />
          </button>
        </span>
      </header>

      {error && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {loading ? (
        <Skeleton height={168} radius={24} />
      ) : (
        <section
          className={`card-hero ${settled ? 'is-neutral' : isPositive ? 'is-positive' : 'is-negative'}`}
          style={{ marginBottom: 'var(--sp-5)' }}
        >
          <span className="label">Overall balance</span>
          <div
            className={`amount-xl ${settled ? '' : isPositive ? 'text-positive' : 'text-negative'}`}
            style={{ margin: '6px 0 4px' }}
          >
            {formatLKRSigned(netBalance)}
          </div>
          <span className="hint">
            {settled
              ? 'You are all square with everyone'
              : isPositive
                ? 'You are owed across all your groups'
                : 'You owe across all your groups'}
          </span>

          <div
            className="row card-divider"
            style={{ gap: 'var(--sp-6)', marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-4)' }}
          >
            <div>
              <div className="label">You are owed</div>
              <div className="amount-md tabular text-positive">{formatLKR(owedToMe)}</div>
            </div>
            <div>
              <div className="label">You owe</div>
              <div className="amount-md tabular text-negative">{formatLKR(owedByMe)}</div>
            </div>
          </div>
        </section>
      )}

      <div className="chip-grid" style={{ marginBottom: 'var(--sp-6)' }}>
        {quickActions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="card card-interactive"
            style={{
              padding: 'var(--sp-3) 4px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
            }}
            onClick={() => onNavigate(action.route)}
          >
            <action.icon size={19} color="var(--primary-light)" />
            <span style={{ fontSize: '0.72rem', fontWeight: 600 }}>{action.label}</span>
          </button>
        ))}
      </div>

      <div className="row-between" style={{ marginBottom: 'var(--sp-3)' }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          Your groups
        </h2>
        {groups.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate('groups')}>
            See all
          </button>
        )}
      </div>

      {loading ? (
        <Skeleton height={96} radius={18} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon="👥"
          title="No groups yet"
          text="Create a group for your next trip or flat, or join one with an invite code."
          action={
            <button type="button" className="btn btn-primary" onClick={() => onNavigate('groups')}>
              Get started
            </button>
          }
        />
      ) : (
        <div className="rail">
          {groups.map((group) => {
            const balance = groupBalances[group.id] ?? 0;
            const groupSettled = Math.abs(balance) < 0.01;
            return (
              <button
                key={group.id}
                type="button"
                className="card card-interactive"
                style={{ width: 150, textAlign: 'left' }}
                onClick={() => onNavigate(`group-detail/${group.id}`)}
              >
                <span style={{ fontSize: 26, display: 'block', marginBottom: 6 }}>{group.icon_emoji}</span>
                <span
                  className="truncate"
                  style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem', marginBottom: 2 }}
                >
                  {group.name}
                </span>
                <span
                  className={`hint tabular ${groupSettled ? '' : balance > 0 ? 'text-positive' : 'text-negative'}`}
                >
                  {groupSettled ? 'Settled' : formatLKRSigned(balance)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <h2 className="section-title">Recent activity</h2>

      {loading ? (
        <SkeletonRows count={3} height={58} />
      ) : recent.length === 0 ? (
        <EmptyState icon="🧾" title="Nothing yet" text="Group expenses will show up here as they are added." />
      ) : (
        <div className="card card-flush">
          {recent.map((expense) => {
            const meta = categoryMeta(expense.category);
            return (
              <button
                key={expense.id}
                type="button"
                className="list-row list-row-interactive"
                onClick={() => expense.group_id && onNavigate(`group-detail/${expense.group_id}`)}
              >
                <span className="icon-tile" style={{ width: 36, height: 36, fontSize: 17 }}>
                  {meta.emoji}
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="truncate" style={{ display: 'block', fontSize: '0.89rem', fontWeight: 600 }}>
                    {expense.title}
                  </span>
                  <span className="hint">
                    {expense.paid_by === user.id ? 'You' : expense.paid_by_user?.display_name ?? 'Someone'} paid ·{' '}
                    {friendlyDate(expense.created_at.slice(0, 10))}
                  </span>
                </span>
                <span className="amount-md tabular">{formatLKR(expense.amount)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
