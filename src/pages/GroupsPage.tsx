import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Group, GroupInvitation, InviteLookup, User } from '../types';
import { formatLKRSigned } from '../lib/currency';
import { friendlyDbError } from '../lib/authErrors';
import { Alert, EmptyState, Sheet, SkeletonRows, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';
import { Archive, Check, Plus, Search, Users2, X } from 'lucide-react';

interface GroupsPageProps {
  user: User;
  onNavigate: (route: string) => void;
}

const EMOJIS = ['💰', '🏠', '🎉', '✈️', '🍔', '🚗', '🎓', '💼', '🏖️', '🎮', '🛍️', '💊'];

export const GroupsPage: React.FC<GroupsPageProps> = ({ user, onNavigate }) => {
  const toast = useToast();

  const [groups, setGroups] = useState<Group[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [invitations, setInvitations] = useState<GroupInvitation[]>([]);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

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

      // Direct 1:1 groups back friend-to-friend loans and belong on the Friends
      // screen, not here — they are a ledger, not somewhere you add bills.
      const list = (data ?? [])
        .map((row: any) => row.groups)
        .filter(Boolean)
        .filter((g: Group) => !g.is_direct) as Group[];
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

      const { data: inviteData } = await supabase
        .from('group_invitations')
        .select('*, groups(name, icon_emoji), inviter:users!group_invitations_invited_by_fkey(*)')
        .eq('invited_user_id', user.id)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false });
      setInvitations((inviteData ?? []) as unknown as GroupInvitation[]);
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not load your groups.'));
    } finally {
      setLoading(false);
    }
  }, [user.id, toast]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const handleRespondToInvitation = async (invitation: GroupInvitation, accept: boolean) => {
    setRespondingTo(invitation.id);
    try {
      const { error } = await supabase.rpc('respond_to_group_invitation', {
        p_invitation_id: invitation.id,
        p_accept: accept,
      });
      if (error) throw error;

      if (accept) {
        toast.success(`You joined "${invitation.groups?.name ?? 'the group'}".`);
      } else {
        toast.info('Invitation declined.');
      }
      await loadGroups();
    } catch (error) {
      toast.error(friendlyDbError(error, 'Could not respond to the invitation.'));
    } finally {
      setRespondingTo(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);

    try {
      // Creates the group and seats the creator as ADMIN atomically, server
      // side — see create_group in supabase_schema.sql for why this isn't two
      // plain inserts.
      const { data: group, error } = await supabase.rpc('create_group', {
        p_name: name.trim(),
        p_description: description.trim(),
        p_icon_emoji: emoji,
      });

      if (error) throw error;

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

  // Archived groups stay out of the way until asked for, but are never lost.
  const archivedCount = groups.filter((g) => g.archived_at).length;
  const visibleGroups = showArchived ? groups : groups.filter((g) => !g.archived_at);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Groups</h1>
          <p className="page-subtitle">{groups.length - archivedCount} active</p>
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

      {invitations.length > 0 && (
        <div className="stack-sm" style={{ marginBottom: 'var(--sp-5)' }}>
          <span className="label">
            {invitations.length} group invitation{invitations.length === 1 ? '' : 's'}
          </span>
          {invitations.map((inv) => (
            <div key={inv.id} className="card row">
              <span
                className="icon-tile"
                style={{ width: 42, height: 42, fontSize: 20, background: 'var(--primary-container)' }}
              >
                {inv.groups?.icon_emoji ?? '💰'}
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="truncate" style={{ display: 'block', fontWeight: 700, fontSize: '0.92rem' }}>
                  {inv.groups?.name ?? 'A group'}
                </span>
                <span className="hint truncate" style={{ display: 'block' }}>
                  {inv.inviter ? `Invited by ${inv.inviter.display_name}` : 'You were invited'}
                </span>
              </span>
              <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  className="btn-icon"
                  style={{ width: 32, height: 32 }}
                  onClick={() => handleRespondToInvitation(inv, false)}
                  disabled={respondingTo === inv.id}
                  aria-label={`Decline invitation to ${inv.groups?.name ?? 'group'}`}
                >
                  <X size={15} />
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => handleRespondToInvitation(inv, true)}
                  disabled={respondingTo === inv.id}
                >
                  {respondingTo === inv.id ? <Spinner /> : <Check size={14} />}
                  Join
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {archivedCount > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginBottom: 'var(--sp-3)' }}
          onClick={() => setShowArchived((current) => !current)}
        >
          <Archive size={14} />
          {showArchived ? 'Hide' : 'Show'} {archivedCount} archived
        </button>
      )}

      {loading ? (
        <SkeletonRows count={3} height={82} />
      ) : visibleGroups.length === 0 ? (
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
          {visibleGroups.map((group) => {
            const balance = balances[group.id] ?? 0;
            const settled = Math.abs(balance) < 0.01;
            return (
              <button
                key={group.id}
                type="button"
                className="card card-interactive row"
                onClick={() => onNavigate(`group-detail/${group.id}`)}
                style={group.archived_at ? { opacity: 0.6 } : undefined}
              >
                <span
                  className="icon-tile"
                  style={{ width: 50, height: 50, fontSize: 24, background: 'var(--primary-container)' }}
                >
                  {group.icon_emoji}
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row" style={{ gap: 5 }}>
                    <span className="truncate" style={{ fontWeight: 700, fontSize: '0.98rem' }}>
                      {group.name}
                    </span>
                    {group.archived_at && <span className="badge">Archived</span>}
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
