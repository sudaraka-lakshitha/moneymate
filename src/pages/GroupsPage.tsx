import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Group, InviteLookup, User } from '../types';
import { formatLKRSigned } from '../lib/currency';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, EmptyState, Sheet, SkeletonRows, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';
import { Plus, Search, Users2 } from 'lucide-react';

interface GroupsPageProps {
  user: User;
  onNavigate: (route: string) => void;
}

const EMOJIS = ['💰', '🏠', '🎉', '✈️', '🍔', '🚗', '🎓', '💼', '🏖️', '🎮', '🛍️', '💊'];

const randomCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — easier to read aloud
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
};

export const GroupsPage: React.FC<GroupsPageProps> = ({ user, onNavigate }) => {
  const toast = useToast();

  const [groups, setGroups] = useState<Group[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('💰');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [inviteCode, setInviteCode] = useState('');
  const [lookup, setLookup] = useState<InviteLookup | null>(null);
  const [checking, setChecking] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinNotice, setJoinNotice] = useState<string | null>(null);

  const loadGroups = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('group_members')
        .select('group_id, groups(*)')
        .eq('user_id', user.id);

      if (error) throw error;

      const list = (data ?? []).map((row: any) => row.groups).filter(Boolean) as Group[];
      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setGroups(list);

      if (list.length > 0) {
        const { data: ledger } = await supabase
          .from('ledger_entries')
          .select('group_id, user_id, amount')
          .eq('user_id', user.id)
          .in('group_id', list.map((g) => g.id));

        const perGroup: Record<string, number> = {};
        for (const row of ledger ?? []) {
          perGroup[row.group_id] = (perGroup[row.group_id] || 0) + Number(row.amount);
        }
        setBalances(perGroup);
      }
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not load your groups.'));
    } finally {
      setLoading(false);
    }
  }, [user.id, toast]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);

    try {
      const { data: group, error } = await supabase
        .from('groups')
        .insert({
          name: name.trim(),
          description: description.trim(),
          icon_emoji: emoji,
          created_by: user.id,
          invite_code: randomCode(),
          invite_code_expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        })
        .select()
        .single();

      if (error) throw error;

      const { error: memberError } = await supabase
        .from('group_members')
        .insert({ group_id: group.id, user_id: user.id, role: 'ADMIN' });

      // Without a membership row the creator cannot even read their own group
      // back (RLS is membership-based), so clean up rather than orphan it.
      if (memberError) {
        await supabase.from('groups').delete().eq('id', group.id);
        throw memberError;
      }

      toast.success(`"${group.name}" created.`);
      setShowCreate(false);
      setName('');
      setDescription('');
      setEmoji('💰');
      await loadGroups();
      onNavigate(`group-detail/${group.id}`);
    } catch (error) {
      setCreateError(friendlyDbError(error, 'Could not create the group.'));
    } finally {
      setCreating(false);
    }
  };

  /** Looks the code up through the RPC — a direct select is blocked by RLS. */
  const handleCheckCode = async () => {
    const code = inviteCode.trim().toUpperCase();
    if (code.length < 4) return;

    setChecking(true);
    setJoinError(null);
    setJoinNotice(null);
    setLookup(null);

    try {
      const { data, error } = await supabase.rpc('find_group_by_invite_code', { p_code: code });
      if (error) throw error;

      const match = (data as InviteLookup[])?.[0];
      if (!match) {
        setJoinError('No group uses that code. Double-check it with the group admin.');
        return;
      }
      if (match.is_expired) {
        setJoinError(`"${match.name}" has an expired invite code. Ask an admin to generate a new one.`);
        return;
      }
      if (match.already_member) {
        setJoinError(`You are already a member of "${match.name}".`);
        return;
      }
      if (match.has_pending_request) {
        setJoinNotice(`Your request to join "${match.name}" is already waiting for admin approval.`);
        return;
      }
      setLookup(match);
    } catch (error) {
      setJoinError(friendlyDbError(error, 'Could not check that code.'));
    } finally {
      setChecking(false);
    }
  };

  const handleJoin = async () => {
    setJoining(true);
    setJoinError(null);

    try {
      const { data, error } = await supabase.rpc('request_to_join_group', {
        p_code: inviteCode.trim().toUpperCase(),
      });
      if (error) throw error;

      const result = (data as { out_status: string; out_group_name: string }[])?.[0];
      switch (result?.out_status) {
        case 'REQUESTED':
          setJoinNotice(`Request sent to the "${result.out_group_name}" admin for approval.`);
          setLookup(null);
          setInviteCode('');
          break;
        case 'ALREADY_MEMBER':
          setJoinError(`You are already in "${result.out_group_name}".`);
          break;
        case 'ALREADY_PENDING':
          setJoinNotice('Your request is already waiting for approval.');
          break;
        case 'EXPIRED':
          setJoinError('That invite code has expired. Ask an admin for a new one.');
          break;
        default:
          setJoinError('No group uses that code.');
      }
    } catch (error) {
      setJoinError(friendlyDbError(error, 'Could not send the join request.'));
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Groups</h1>
          <p className="page-subtitle">{groups.length} active</p>
        </div>
        <div className="row" style={{ gap: 'var(--sp-2)' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowJoin(true)}>
            <Search size={15} /> Join
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            <Plus size={15} /> New
          </button>
        </div>
      </header>

      {loading ? (
        <SkeletonRows count={3} height={82} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon="👥"
          title="No groups yet"
          text="Create one for your trip, flat or team — or join an existing one with a 6-character code."
          action={
            <div className="row" style={{ justifyContent: 'center' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowJoin(true)}>
                Join with code
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
                Create a group
              </button>
            </div>
          }
        />
      ) : (
        <div className="stack">
          {groups.map((group) => {
            const balance = balances[group.id] ?? 0;
            const settled = Math.abs(balance) < 0.01;
            return (
              <button
                key={group.id}
                type="button"
                className="card card-interactive row"
                onClick={() => onNavigate(`group-detail/${group.id}`)}
              >
                <span
                  className="icon-tile"
                  style={{ width: 50, height: 50, fontSize: 24, background: 'var(--primary-container)' }}
                >
                  {group.icon_emoji}
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="truncate" style={{ display: 'block', fontWeight: 700, fontSize: '0.98rem' }}>
                    {group.name}
                  </span>
                  <span className="hint">
                    Code <strong style={{ color: 'var(--primary-light)', letterSpacing: 1 }}>{group.invite_code}</strong>
                  </span>
                </span>
                <span style={{ textAlign: 'right', flexShrink: 0 }}>
                  <span
                    className={`amount-md tabular ${settled ? 'text-neutral' : balance > 0 ? 'text-positive' : 'text-negative'}`}
                    style={{ display: 'block' }}
                  >
                    {settled ? 'Settled' : formatLKRSigned(balance)}
                  </span>
                  <span className="hint">{settled ? 'all square' : balance > 0 ? 'you are owed' : 'you owe'}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {showCreate && (
        <Sheet title="Create a group" onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} className="stack">
            <div className="field">
              <span className="label label-block">Pick an icon</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
                {EMOJIS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`emoji-btn ${emoji === option ? 'is-selected' : ''}`}
                    onClick={() => setEmoji(option)}
                    aria-label={`Icon ${option}`}
                    aria-pressed={emoji === option}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>

            <input
              type="text"
              className="input"
              placeholder="Group name (e.g. Galle Trip)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
              autoFocus
            />
            <input
              type="text"
              className="input"
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={140}
            />

            {createError && <Alert variant="error">{createError}</Alert>}

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={creating}>
              {creating && <Spinner />}
              {creating ? 'Creating…' : 'Create group'}
            </button>
          </form>
        </Sheet>
      )}

      {showJoin && (
        <Sheet
          title="Join a group"
          onClose={() => {
            setShowJoin(false);
            setLookup(null);
            setJoinError(null);
            setJoinNotice(null);
          }}
        >
          <div className="stack">
            <p className="text-muted" style={{ fontSize: '0.87rem' }}>
              Enter the 6-character code from the group admin. They will approve your request before you can
              see any expenses.
            </p>

            <input
              type="text"
              className="input code-input"
              placeholder="ABC123"
              value={inviteCode}
              onChange={(e) => {
                setInviteCode(e.target.value.toUpperCase().slice(0, 6));
                setLookup(null);
                setJoinError(null);
                setJoinNotice(null);
              }}
              maxLength={6}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />

            {joinError && <Alert variant="error">{joinError}</Alert>}
            {joinNotice && <Alert variant="success">{joinNotice}</Alert>}

            {lookup && (
              <div className="card row">
                <span className="icon-tile" style={{ width: 44, height: 44, fontSize: 22 }}>
                  {lookup.icon_emoji}
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="truncate" style={{ display: 'block', fontWeight: 700 }}>
                    {lookup.name}
                  </span>
                  <span className="hint row" style={{ gap: 4 }}>
                    <Users2 size={12} /> {lookup.member_count} member{lookup.member_count === 1 ? '' : 's'}
                  </span>
                </span>
              </div>
            )}

            {lookup ? (
              <button type="button" className="btn btn-primary btn-block btn-lg" onClick={handleJoin} disabled={joining}>
                {joining && <Spinner />}
                {joining ? 'Sending…' : `Request to join ${lookup.name}`}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-block btn-lg"
                onClick={handleCheckCode}
                disabled={checking || inviteCode.trim().length < 4}
              >
                {checking && <Spinner />}
                {checking ? 'Checking…' : 'Find group'}
              </button>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
};
