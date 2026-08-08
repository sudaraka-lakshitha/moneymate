import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { FriendRequest, Group, User } from '../types';
import { formatLKR, formatLKRSigned } from '../lib/currency';
import { computeFriendBalances, FriendBalanceDetail, GroupLedger, netByUser } from '../lib/balances';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, Avatar, EmptyState, Sheet, SkeletonRows, Spinner } from '../components/ui';
import { SettleUpSheet, SettleTarget } from '../components/SettleUpSheet';
import { useToast } from '../components/Toast';
import { Check, Clock, UserPlus, Search, X, Pin } from 'lucide-react';

interface FriendsPageProps {
  user: User;
}

/** A row shown in the list — either shared-balance data, a direct connection, or both. */
interface DisplayFriend extends FriendBalanceDetail {
  isConnected: boolean;
  isPinned: boolean;
}

const emailOf = (row: FriendRequest, meId: string): string =>
  (row.requester_id === meId ? row.addressee?.display_name : row.requester?.display_name) ||
  row.addressee_email;

export const FriendsPage: React.FC<FriendsPageProps> = ({ user }) => {
  const toast = useToast();

  const [friends, setFriends] = useState<DisplayFriend[]>([]);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<DisplayFriend | null>(null);
  const [settleTarget, setSettleTarget] = useState<SettleTarget | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data: memberships, error: membershipError } = await supabase
        .from('group_members')
        .select('group_id, groups(*)')
        .eq('user_id', user.id);
      if (membershipError) throw membershipError;

      const groups = (memberships ?? []).map((row: any) => row.groups).filter(Boolean) as Group[];
      const groupIds = groups.map((g) => g.id);

      const [memberRes, ledgerRes, requestRes, pinRes] = await Promise.all([
        groupIds.length > 0
          ? supabase.from('group_members').select('group_id, user_id, users(*)').in('group_id', groupIds)
          : Promise.resolve({ data: [], error: null }),
        groupIds.length > 0
          ? supabase.from('ledger_entries').select('group_id, user_id, amount').in('group_id', groupIds)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from('friend_requests')
          .select(
            '*, requester:users!friend_requests_requester_id_fkey(*), addressee:users!friend_requests_addressee_id_fkey(*)'
          )
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
          .in('status', ['PENDING', 'ACCEPTED']),
        supabase.from('friend_pins').select('friend_id').eq('user_id', user.id),
      ]);

      if (memberRes.error) throw memberRes.error;
      if (ledgerRes.error) throw ledgerRes.error;
      if (requestRes.error) throw requestRes.error;

      const pinnedIds = new Set((pinRes.data ?? []).map((row: any) => row.friend_id as string));

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

      const balanceFriends = computeFriendBalances(ledgers, user.id);
      const requests = (requestRes.data ?? []) as unknown as FriendRequest[];

      const accepted = requests.filter((r) => r.status === 'ACCEPTED');
      const connectedIds = new Set(
        accepted.map((r) => (r.requester_id === user.id ? r.addressee_id : r.requester_id)).filter(Boolean)
      );

      const merged: DisplayFriend[] = balanceFriends.map((f) => ({
        ...f,
        isConnected: connectedIds.has(f.friend.id),
        isPinned: pinnedIds.has(f.friend.id),
      }));

      // Every accepted friend appears, whether or not you share a group and
      // whether or not there is money between you — a friend you added should
      // never be invisible just because you are square. Falls back to the stored
      // email when the profile row is unreadable, so the row still renders.
      for (const row of accepted) {
        const friendUser = row.requester_id === user.id ? row.addressee : row.requester;
        const friendId = row.requester_id === user.id ? row.addressee_id : row.requester_id;
        if (merged.some((m) => m.friend.id === (friendUser?.id ?? friendId))) continue;

        const resolved: User = friendUser ?? {
          id: friendId ?? row.id,
          display_name: row.addressee_email,
          email: row.addressee_email,
        };

        merged.push({
          friend: resolved,
          net_balance: 0,
          total_they_owe_me: 0,
          total_i_owe_them: 0,
          shared_group_count: 0,
          perGroup: [],
          isConnected: true,
          isPinned: pinnedIds.has(resolved.id),
        });
      }

      // Pinned first, then by how much money is at stake, then settled friends.
      merged.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return Math.abs(b.net_balance) - Math.abs(a.net_balance);
      });
      setFriends(merged);
      setIncoming(requests.filter((r) => r.status === 'PENDING' && r.addressee_id === user.id));
      setOutgoing(requests.filter((r) => r.status === 'PENDING' && r.requester_id === user.id));
    } catch (err) {
      setError(friendlyDbError(err, 'Could not load your friends.'));
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

  const handleSendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    setSending(true);

    try {
      const { data, error: rpcError } = await supabase.rpc('send_friend_request', {
        p_email: addEmail.trim(),
      });
      if (rpcError) throw rpcError;

      const result = (data as { out_status: string }[])?.[0];
      switch (result?.out_status) {
        case 'SENT':
          toast.success('Friend request sent.');
          setShowAdd(false);
          setAddEmail('');
          await load();
          break;
        case 'SENT_PENDING_SIGNUP':
          toast.success("Sent — they'll see it once they sign up with that email.");
          setShowAdd(false);
          setAddEmail('');
          await load();
          break;
        case 'ACCEPTED_EXISTING':
          toast.success("You're now friends — they had already added you!");
          setShowAdd(false);
          setAddEmail('');
          await load();
          break;
        case 'ALREADY_FRIENDS':
          setAddError("You're already friends with them.");
          break;
        case 'ALREADY_PENDING':
          setAddError('Already sent — waiting on a response.');
          break;
        case 'SELF':
          setAddError("That's your own email.");
          break;
        case 'INVALID_EMAIL':
          setAddError('Enter a valid email address.');
          break;
        default:
          setAddError('Could not send the request.');
      }
    } catch (err) {
      setAddError(friendlyDbError(err, 'Could not send the request.'));
    } finally {
      setSending(false);
    }
  };

  const handleRespond = async (request: FriendRequest, accept: boolean) => {
    setRespondingTo(request.id);
    try {
      const { error: rpcError } = await supabase.rpc('respond_to_friend_request', {
        p_request_id: request.id,
        p_accept: accept,
      });
      if (rpcError) throw rpcError;
      toast[accept ? 'success' : 'info'](
        accept ? `You and ${request.requester?.display_name ?? 'they'} are now friends.` : 'Request declined.'
      );
      await load();
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not respond to the request.'));
    } finally {
      setRespondingTo(null);
    }
  };

  const handleCancel = async (request: FriendRequest) => {
    setRespondingTo(request.id);
    try {
      const { error: rpcError } = await supabase.rpc('cancel_friend_request', {
        p_request_id: request.id,
      });
      if (rpcError) throw rpcError;
      toast.info('Request withdrawn.');
      await load();
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not withdraw the request.'));
    } finally {
      setRespondingTo(null);
    }
  };

  const handleTogglePin = async (friend: DisplayFriend) => {
    setPinningId(friend.friend.id);

    // Flip locally first: pinning is a list-ordering preference, and waiting on
    // a round trip to reorder makes the tap feel broken.
    const wasPinned = friend.isPinned;
    setFriends((current) =>
      current
        .map((f) => (f.friend.id === friend.friend.id ? { ...f, isPinned: !wasPinned } : f))
        .sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          return Math.abs(b.net_balance) - Math.abs(a.net_balance);
        })
    );

    try {
      if (wasPinned) {
        const { error: unpinError } = await supabase
          .from('friend_pins')
          .delete()
          .eq('user_id', user.id)
          .eq('friend_id', friend.friend.id);
        if (unpinError) throw unpinError;
      } else {
        const { error: pinError } = await supabase
          .from('friend_pins')
          .insert({ user_id: user.id, friend_id: friend.friend.id });
        if (pinError) throw pinError;
      }
    } catch (err) {
      toast.error(friendlyDbError(err, 'Could not update the pin.'));
      await load(); // put the list back the way the server sees it
    } finally {
      setPinningId(null);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Friends</h1>
          <p className="page-subtitle">What you owe, and what you are owed</p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>
          <UserPlus size={15} /> Add
        </button>
      </header>

      {error && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {incoming.length > 0 && (
        <div className="stack-sm" style={{ marginBottom: 'var(--sp-5)' }}>
          <span className="label">
            {incoming.length} friend request{incoming.length === 1 ? '' : 's'}
          </span>
          {incoming.map((req) => (
            <div key={req.id} className="card row">
              <Avatar name={req.requester?.display_name} url={req.requester?.avatar_url} size={40} />
              <span className="grow truncate" style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                {req.requester?.display_name ?? req.addressee_email}
              </span>
              <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  className="btn-icon"
                  style={{ width: 32, height: 32 }}
                  onClick={() => handleRespond(req, false)}
                  disabled={respondingTo === req.id}
                  aria-label="Decline"
                >
                  <X size={15} />
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => handleRespond(req, true)}
                  disabled={respondingTo === req.id}
                >
                  {respondingTo === req.id ? <Spinner /> : <Check size={14} />}
                  Accept
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <div className="stack-sm" style={{ marginBottom: 'var(--sp-5)' }}>
          <span className="label">Waiting on a response</span>
          {outgoing.map((req) => (
            <div key={req.id} className="card row">
              <span className="icon-tile" style={{ width: 40, height: 40 }}>
                <Clock size={16} color="var(--on-surface-variant)" />
              </span>
              <span className="grow truncate" style={{ fontSize: '0.9rem' }}>
                {emailOf(req, user.id)}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleCancel(req)}
                disabled={respondingTo === req.id}
              >
                {respondingTo === req.id ? <Spinner /> : 'Cancel'}
              </button>
            </div>
          ))}
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
              : 'Add a friend by email, or join a group and split a bill — everyone you share a group with shows up here.'
          }
          action={
            !search && (
              <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
                <UserPlus size={15} /> Add a friend
              </button>
            )
          }
        />
      ) : (
        <div className="stack-sm">
          {filtered.map((friend) => {
            const settled = Math.abs(friend.net_balance) < 0.01;
            return (
              // A div, not a button: the pin is its own control and a button
              // cannot legally nest inside another button.
              <div key={friend.friend.id} className="card card-interactive row">
                <button
                  type="button"
                  className="row grow"
                  onClick={() => setSelected(friend)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    minWidth: 0,
                    textAlign: 'left',
                    font: 'inherit',
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  <Avatar name={friend.friend.display_name} url={friend.friend.avatar_url} size={42} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="row" style={{ gap: 5 }}>
                      <span className="truncate" style={{ fontWeight: 700, fontSize: '0.93rem' }}>
                        {friend.friend.display_name}
                      </span>
                      {friend.isConnected && <span className="badge badge-info">Friend</span>}
                    </span>
                    <span className="hint">
                      {friend.shared_group_count > 0
                        ? `${friend.shared_group_count} shared group${friend.shared_group_count === 1 ? '' : 's'}`
                        : 'No shared groups yet'}
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

                <button
                  type="button"
                  className="btn-icon"
                  style={{ width: 30, height: 30, flexShrink: 0 }}
                  onClick={() => handleTogglePin(friend)}
                  disabled={pinningId === friend.friend.id}
                  aria-pressed={friend.isPinned}
                  aria-label={
                    friend.isPinned
                      ? `Unpin ${friend.friend.display_name}`
                      : `Pin ${friend.friend.display_name} to the top`
                  }
                  title={friend.isPinned ? 'Unpin' : 'Pin to top'}
                >
                  {/* Same icon either way, filled when pinned. A crossed-out pin
                      here would read as "pinning is disabled" rather than
                      "tap to pin". */}
                  <Pin
                    size={14}
                    fill={friend.isPinned ? 'currentColor' : 'none'}
                    color={friend.isPinned ? 'var(--primary)' : 'var(--on-surface-faint)'}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <Sheet title={selected.friend.display_name} onClose={() => setSelected(null)}>
          <div className="stack">
            <div className="row" style={{ justifyContent: 'center', flexDirection: 'column', gap: 'var(--sp-2)' }}>
              <Avatar name={selected.friend.display_name} url={selected.friend.avatar_url} size={64} />
              {selected.isConnected && <span className="badge badge-info">Friend</span>}
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
              <EmptyState
                icon="✅"
                title="Nothing outstanding"
                text={
                  selected.shared_group_count === 0
                    ? 'You are connected, but have not shared a group or bill yet.'
                    : 'No open balances with this friend.'
                }
              />
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

      {showAdd && (
        <Sheet
          title="Add a friend"
          onClose={() => {
            setShowAdd(false);
            setAddError(null);
          }}
        >
          <form onSubmit={handleSendRequest} className="stack">
            <p className="text-muted" style={{ fontSize: '0.87rem' }}>
              Enter their email. If they're already on MoneyMate, they'll get a request to accept. If not,
              it'll wait and connect automatically the moment they sign up with that address.
            </p>
            <input
              type="email"
              className="input"
              placeholder="friend@email.com"
              value={addEmail}
              onChange={(e) => {
                setAddEmail(e.target.value);
                setAddError(null);
              }}
              autoFocus
              required
            />
            {addError && <Alert variant="error">{addError}</Alert>}
            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={sending || !addEmail.trim()}>
              {sending && <Spinner />}
              {sending ? 'Sending…' : 'Send friend request'}
            </button>
          </form>
        </Sheet>
      )}
    </div>
  );
};
