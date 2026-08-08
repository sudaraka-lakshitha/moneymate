import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Group, User } from '../types';
import { formatLKR, formatLKRSigned } from '../lib/currency';
import { computeFriendBalances, FriendBalanceDetail, GroupLedger, netByUser } from '../lib/balances';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, Avatar, EmptyState, Sheet, SkeletonRows } from '../components/ui';
import { SettleUpSheet, SettleTarget } from '../components/SettleUpSheet';
import { Search } from 'lucide-react';

interface FriendsPageProps {
  user: User;
}

export const FriendsPage: React.FC<FriendsPageProps> = ({ user }) => {
  const [friends, setFriends] = useState<FriendBalanceDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<FriendBalanceDetail | null>(null);
  const [settleTarget, setSettleTarget] = useState<SettleTarget | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data: memberships, error: membershipError } = await supabase
        .from('group_members')
        .select('group_id, groups(*)')
        .eq('user_id', user.id);
      if (membershipError) throw membershipError;

      const groups = (memberships ?? []).map((row: any) => row.groups).filter(Boolean) as Group[];
      if (groups.length === 0) {
        setFriends([]);
        return;
      }

      const groupIds = groups.map((g) => g.id);

      const [memberRes, ledgerRes] = await Promise.all([
        supabase.from('group_members').select('group_id, user_id, users(*)').in('group_id', groupIds),
        supabase.from('ledger_entries').select('group_id, user_id, amount').in('group_id', groupIds),
      ]);

      if (memberRes.error) throw memberRes.error;
      if (ledgerRes.error) throw ledgerRes.error;

      const ledgers: GroupLedger[] = groups.map((group) => ({
        groupId: group.id,
        groupName: group.name,
        balances: netByUser((ledgerRes.data ?? []).filter((row: any) => row.group_id === group.id)),
        members: Object.fromEntries(
          (memberRes.data ?? [])
            .filter((row: any) => row.group_id === group.id && row.users)
            .map((row: any) => [row.user_id, row.users as User])
        ),
      }));

      setFriends(computeFriendBalances(ledgers, user.id));
    } catch (err) {
      setError(friendlyDbError(err, 'Could not load friend balances.'));
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    let owedToMe = 0;
    let owedByMe = 0;
    for (const friend of friends) {
      if (friend.net_balance > 0) owedToMe += friend.net_balance;
      else owedByMe += Math.abs(friend.net_balance);
    }
    return { owedToMe, owedByMe, net: owedToMe - owedByMe };
  }, [friends]);

  const filtered = friends.filter((f) =>
    f.friend.display_name.toLowerCase().includes(search.trim().toLowerCase())
  );

  const isPositive = totals.net >= 0;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Friends</h1>
          <p className="page-subtitle">What you owe, and what you are owed</p>
        </div>
      </header>

      {error && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <section
        className={`card-hero ${Math.abs(totals.net) < 0.01 ? 'is-neutral' : isPositive ? 'is-positive' : 'is-negative'}`}
        style={{ marginBottom: 'var(--sp-5)' }}
      >
        <span className="label">Net across all friends</span>
        <div
          className={`amount-xl tabular ${Math.abs(totals.net) < 0.01 ? '' : isPositive ? 'text-positive' : 'text-negative'}`}
          style={{ margin: '6px 0 4px' }}
        >
          {formatLKRSigned(totals.net)}
        </div>
        <span className="hint">
          {Math.abs(totals.net) < 0.01
            ? 'Everyone is square'
            : isPositive
              ? 'You are owed overall'
              : 'You owe overall'}
        </span>

        <div className="row card-divider" style={{ gap: 'var(--sp-6)', marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-4)' }}>
          <div>
            <div className="label">You are owed</div>
            <div className="amount-md tabular text-positive">{formatLKR(totals.owedToMe)}</div>
          </div>
          <div>
            <div className="label">You owe</div>
            <div className="amount-md tabular text-negative">{formatLKR(totals.owedByMe)}</div>
          </div>
        </div>
      </section>

      {friends.length > 4 && (
        <div className="card row" style={{ padding: '6px var(--sp-4)', marginBottom: 'var(--sp-4)' }}>
          <Search size={17} color="var(--on-surface-variant)" />
          <input
            type="search"
            className="grow"
            placeholder="Search friends…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ background: 'none', border: 'none', outline: 'none', padding: '8px 0', fontSize: '0.9rem' }}
          />
        </div>
      )}

      {loading ? (
        <SkeletonRows count={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="🤝"
          title={search ? 'No matches' : 'No friends yet'}
          text={
            search
              ? 'Try a different name.'
              : 'Join a group and split a bill — everyone you share a group with shows up here.'
          }
        />
      ) : (
        <div className="stack-sm">
          {filtered.map((friend) => {
            const settled = Math.abs(friend.net_balance) < 0.01;
            return (
              <button
                key={friend.friend.id}
                type="button"
                className="card card-interactive row"
                onClick={() => setSelected(friend)}
              >
                <Avatar name={friend.friend.display_name} url={friend.friend.avatar_url} size={42} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="truncate" style={{ display: 'block', fontWeight: 700, fontSize: '0.93rem' }}>
                    {friend.friend.display_name}
                  </span>
                  <span className="hint">
                    {friend.shared_group_count} shared group{friend.shared_group_count === 1 ? '' : 's'}
                  </span>
                </span>
                <span style={{ textAlign: 'right', flexShrink: 0 }}>
                  <span
                    className={`amount-md tabular ${settled ? 'text-neutral' : friend.net_balance > 0 ? 'text-positive' : 'text-negative'}`}
                    style={{ display: 'block' }}
                  >
                    {settled ? 'Settled' : formatLKR(Math.abs(friend.net_balance))}
                  </span>
                  <span className="hint">
                    {settled ? 'all square' : friend.net_balance > 0 ? 'owes you' : 'you owe'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <Sheet title={selected.friend.display_name} onClose={() => setSelected(null)}>
          <div className="stack">
            <div className="row" style={{ justifyContent: 'center', flexDirection: 'column', gap: 'var(--sp-2)' }}>
              <Avatar name={selected.friend.display_name} url={selected.friend.avatar_url} size={64} />
              <span
                className={`amount-lg tabular ${
                  Math.abs(selected.net_balance) < 0.01
                    ? 'text-neutral'
                    : selected.net_balance > 0
                      ? 'text-positive'
                      : 'text-negative'
                }`}
              >
                {formatLKRSigned(selected.net_balance)}
              </span>
              <span className="hint">
                {Math.abs(selected.net_balance) < 0.01
                  ? 'You are all square'
                  : selected.net_balance > 0
                    ? `${selected.friend.display_name} owes you`
                    : `You owe ${selected.friend.display_name}`}
              </span>
            </div>

            {selected.perGroup.length === 0 ? (
              <EmptyState icon="✅" title="Nothing outstanding" text="No open balances with this friend." />
            ) : (
              <>
                <span className="label label-block">Breakdown by group</span>
                <div className="stack-sm">
                  {selected.perGroup.map((entry) => (
                    <div key={entry.groupId} className="card row-between">
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="truncate" style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem' }}>
                          {entry.groupName}
                        </span>
                        <span className="hint">{entry.net > 0 ? 'owes you' : 'you owe'}</span>
                      </span>
                      <span className="row" style={{ gap: 'var(--sp-3)', flexShrink: 0 }}>
                        <span
                          className={`amount-md tabular ${entry.net > 0 ? 'text-positive' : 'text-negative'}`}
                        >
                          {formatLKR(Math.abs(entry.net))}
                        </span>
                        {entry.net < 0 && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => {
                              setSettleTarget({
                                groupId: entry.groupId,
                                groupName: entry.groupName,
                                payee: selected.friend,
                                suggestedAmount: Math.abs(entry.net),
                              });
                              setSelected(null);
                            }}
                          >
                            Settle
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
                <span className="hint">
                  Settlements are recorded against a group so the group ledger stays balanced.
                </span>
              </>
            )}
          </div>
        </Sheet>
      )}

      {settleTarget && (
        <SettleUpSheet
          target={settleTarget}
          onClose={() => setSettleTarget(null)}
          onSettled={() => {
            setSettleTarget(null);
            setLoading(true);
            void load();
          }}
        />
      )}
    </div>
  );
};
